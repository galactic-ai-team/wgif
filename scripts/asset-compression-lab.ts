#!/usr/bin/env node
/**
 * Asset compression lab (Dee / OPTIMIZATION lane).
 *
 * Takes a .glb (default: the court world's) and measures four variants:
 *   baseline → weld+dedup+prune → +KHR_mesh_quantization → +EXT_meshopt_compression
 * and reports the decoder cost each extension imposes on the player.
 *
 * Nothing here is imported by the player. This is an experiment harness that
 * produces the numbers for docs/ASSET-COMPRESSION.md and the Q4 answer.
 *
 * Usage: tsx scripts/asset-compression-lab.ts [--input examples/court/world.glb] [--json]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { gzipBytes, readZipDirectory } from './size-report.js'

export interface Variant {
  name: string
  bytes: number
  gzip: number
  ok: boolean
  note: string
}

const DECODER_CANDIDATES = [
  'node_modules/meshoptimizer/meshopt_decoder.module.js',
  'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js',
  'node_modules/three/examples/jsm/libs/draco/draco_decoder.js',
]

export function measureDecoders(root: string): { path: string; bytes: number; gzip: number }[] {
  return DECODER_CANDIDATES.filter((rel) => existsSync(path.join(root, rel))).map((rel) => {
    const buf = readFileSync(path.join(root, rel))
    return { path: rel, bytes: buf.byteLength, gzip: gzipBytes(buf) }
  })
}

/** Pull one entry out of a ZIP. Returns null if the entry is absent or unsupported. */
export function extractEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const entry = readZipDirectory(zip).find((e) => e.name === name)
  if (!entry || entry.localHeaderOffset === undefined) return null
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const lh = entry.localHeaderOffset
  if (dv.getUint32(lh, true) !== 0x04034b50) return null
  const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true)
  const raw = zip.subarray(dataStart, dataStart + entry.storedBytes)
  if (entry.method === 0) return raw
  if (entry.method === 8) return new Uint8Array(inflateRawSync(raw))
  return null
}

export interface LabInput {
  /** Human-readable provenance, used in the report. */
  label: string
  /** Path handed to io.read(). A temp file for the extracted case. */
  absPath: string
  /** Set when we wrote a temp file; caller unlinks on exit. */
  cleanup: string | null
}

/**
 * Resolution order:
 *   1. --input <path>                       (explicit always wins)
 *   2. examples/court/world.glb | court.glb (loose file, if it exists)
 *   3. world.glb extracted from examples/court/court.wgif
 *   4. null → caller exits 0 with a clear message (NOT an error: an empty lab
 *      is expected on a fresh checkout before `npm run pack:court`)
 */
export function resolveInput(root: string, explicit: string | null): LabInput | null {
  if (explicit) {
    const abs = path.resolve(root, explicit)
    return existsSync(abs) ? { label: explicit, absPath: abs, cleanup: null } : null
  }
  for (const rel of ['examples/court/world.glb', 'examples/court/court.glb']) {
    const abs = path.join(root, rel)
    if (existsSync(abs)) return { label: rel, absPath: abs, cleanup: null }
  }
  const wgifRel = 'examples/court/court.wgif'
  const wgifAbs = path.join(root, wgifRel)
  if (!existsSync(wgifAbs)) return null
  const data = extractEntry(readFileSync(wgifAbs), 'world.glb')
  if (!data) return null
  const dir = mkdtempSync(path.join(tmpdir(), 'wgif-lab-'))
  const abs = path.join(dir, 'world.glb')
  writeFileSync(abs, data)
  return { label: `${wgifRel} → world.glb (extracted)`, absPath: abs, cleanup: dir }
}

export async function runLab(root: string, relInput: string): Promise<Variant[]> {
  const { NodeIO } = await import('@gltf-transform/core')
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions')
  const { dedup, meshopt, prune, quantize, weld } = await import('@gltf-transform/functions')
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer')

  await MeshoptDecoder.ready
  await MeshoptEncoder.ready
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  })

  const abs = path.isAbsolute(relInput) ? relInput : path.join(root, relInput)
  const baselineBuf = readFileSync(abs)
  const variants: Variant[] = [
    { name: 'baseline', bytes: baselineBuf.byteLength, gzip: gzipBytes(baselineBuf), ok: true, note: 'as shipped' },
  ]

  const doc = await io.read(abs)
  const measure = async (name: string, note: string): Promise<void> => {
    try {
      const out = await io.writeBinary(doc)
      variants.push({ name, bytes: out.byteLength, gzip: gzipBytes(out), ok: true, note })
    } catch (err) {
      variants.push({ name, bytes: 0, gzip: 0, ok: false, note: (err as Error).message })
    }
  }

  await doc.transform(dedup(), weld({ tolerance: 0 }), prune())
  await measure('weld+dedup+prune', 'index sharing, unused data removed')

  await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }))
  await measure('+KHR_mesh_quantization', 'int16/int8 attributes')

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }))
  await measure('+EXT_meshopt_compression', 'meshopt filter + entropy coding')

  return variants
}

export function renderTable(variants: Variant[], decoders: { path: string; bytes: number; gzip: number }[]): string {
  const base = variants[0]?.bytes ?? 0
  const L: string[] = []
  L.push('| Variant | Bytes | vs baseline | gzip | Player decoder cost |')
  L.push('|---|---:|---:|---:|---|')
  const cost: Record<string, string> = {
    baseline: '0',
    'weld+dedup+prune': '0 (build-time only)',
    '+KHR_mesh_quantization': '0 — GLTFLoader handles it natively',
    '+EXT_meshopt_compression': 'meshopt decoder (see below)',
  }
  for (const v of variants) {
    if (!v.ok) {
      L.push(`| ${v.name} | — | — | — | failed: ${v.note} |`)
      continue
    }
    const delta = base > 0 ? `${(((v.bytes - base) / base) * 100).toFixed(1)}%` : 'n/a'
    L.push(`| ${v.name} | ${v.bytes} | ${delta} | ${v.gzip} | ${cost[v.name] ?? ''} |`)
  }
  if (decoders.length > 0) {
    L.push('')
    L.push('Decoder files measured in `node_modules`:')
    L.push('')
    L.push('| File | Raw | gzip |')
    L.push('|---|---:|---:|')
    for (const d of decoders) L.push(`| \`${d.path}\` | ${d.bytes} | ${d.gzip} |`)
  }
  return L.join('\n')
}

async function main(argv: string[]): Promise<number> {
  const root = process.cwd()
  const json = argv.includes('--json')
  const inputIdx = argv.indexOf('--input')
  const explicit = inputIdx >= 0 ? argv[inputIdx + 1] : null
  const input = resolveInput(root, explicit)
  if (!input) {
    console.log(
      'lab: no input. Either build the court (`npm run pack:court`) or pass --input <path/to/glb>.',
    )
    return 0 // not a failure — fresh checkout, nothing to measure yet
  }
  const decoders = measureDecoders(root)
  let variants: Variant[]
  try {
    variants = await runLab(root, input.absPath)
  } catch (err) {
    console.error(`lab failed: ${(err as Error).message}`)
    console.error('hint: `npm i -D meshoptimizer` is required for the meshopt variant (MIT, free).')
    if (input.cleanup) rmSync(input.cleanup, { recursive: true, force: true })
    return 2
  }
  if (json) console.log(JSON.stringify({ input: input.label, variants, decoders }, null, 2))
  else console.log(renderTable(variants, decoders))
  if (input.cleanup) rmSync(input.cleanup, { recursive: true, force: true })
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && /asset-compression-lab\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}