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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { gzipBytes } from './size-report'

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

export function findInput(root: string): string | null {
  const candidates = ['examples/court/world.glb', 'examples/court/court.glb']
  for (const c of candidates) if (existsSync(path.join(root, c))) return c
  return null
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

  const abs = path.join(root, relInput)
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
  const relInput = inputIdx >= 0 ? argv[inputIdx + 1] : findInput(root)
  if (!relInput) {
    console.error('no .glb input found; pass --input <path>')
    return 2
  }
  const decoders = measureDecoders(root)
  let variants: Variant[]
  try {
    variants = await runLab(root, relInput)
  } catch (err) {
    console.error(`lab failed: ${(err as Error).message}`)
    console.error('hint: `npm i -D meshoptimizer` is required for the meshopt variant (MIT, free).')
    return 2
  }
  if (json) console.log(JSON.stringify({ input: relInput, variants, decoders }, null, 2))
  else console.log(renderTable(variants, decoders))
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && /asset-compression-lab\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}