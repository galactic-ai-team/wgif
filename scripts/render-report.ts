#!/usr/bin/env node
/**
 * Court-world render budget analyzer (Dee / OPTIMIZATION lane).
 *
 * Reads a .glb, estimates draw calls / triangles / texture memory from the
 * JSON chunk WITHOUT loading a renderer, and checks against `renderBudget`
 * in scripts/size-budgets.json.
 *
 * Static upper bounds:
 *   draw calls  = mesh primitives (no batching/instancing)
 *   triangles   = index count / 3 (or POSITION count / 3 non-indexed);
 *                 STRIP/FAN use n-2
 *   texture mem = width * height * bpp * 4/3 (mipmaps);
 *                 bpp = 4 for RGBA8, 0.5 for KTX2/BasisU compressed
 *
 * Frame time cannot be verified statically — see docs/PERF.md.
 *
 * Usage:
 *   tsx scripts/render-report.ts
 *   tsx scripts/render-report.ts --input path/to/world.glb
 *   tsx scripts/render-report.ts --budgets scripts/size-budgets.json
 *   tsx scripts/render-report.ts --json
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface RenderBudget {
  targetViewport: { width: number; height: number }
  maxDrawCalls: number
  maxTriangles: number
  maxTextureMemoryMiB: number
  targetFrameTimeMs: number
}

export interface TextureInfo {
  name: string
  width: number
  height: number
  bytes: number
  compressed: boolean
}

export interface GlbAnalysis {
  drawCalls: number
  triangles: number
  textureMemoryBytes: number
  textures: TextureInfo[]
  warnings: string[]
}

export interface RenderViolation {
  id: string
  subject: string
  actual: number
  limit: number
  message: string
}

// ---------------------------------------------------------------------------
// budget loading
// ---------------------------------------------------------------------------

export function loadRenderBudget(budgetsPath: string): RenderBudget {
  const raw = JSON.parse(readFileSync(budgetsPath, 'utf8')) as {
    renderBudget?: Partial<RenderBudget>
  }
  const rb = raw.renderBudget
  if (!rb) throw new Error(`render-budget: ${budgetsPath} has no "renderBudget" block`)
  const required: (keyof RenderBudget)[] = [
    'targetViewport',
    'maxDrawCalls',
    'maxTriangles',
    'maxTextureMemoryMiB',
    'targetFrameTimeMs',
  ]
  for (const key of required) {
    if (rb[key] === undefined) throw new Error(`render-budget: missing "${key}" in ${budgetsPath}`)
  }
  return rb as RenderBudget
}

// ---------------------------------------------------------------------------
// GLB parsing (JSON chunk only for the metadata we need)
// ---------------------------------------------------------------------------

interface ParsedGlb {
  json: Record<string, unknown>
  bin: Uint8Array | null
}

const GLB_MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

function parseGlb(buf: Uint8Array): ParsedGlb {
  if (buf.byteLength < 20) throw new Error('glb: too short')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic (expected "glTF")')
  const version = dv.getUint32(4, true)
  if (version !== 2) throw new Error(`glb: unsupported version ${version}`)
  const totalLen = Math.min(dv.getUint32(8, true), buf.byteLength)

  let jsonChunk: Uint8Array | null = null
  let binChunk: Uint8Array | null = null
  let p = 12
  while (p + 8 <= totalLen) {
    const chunkLen = dv.getUint32(p, true)
    const chunkType = dv.getUint32(p + 4, true)
    const end = p + 8 + chunkLen
    if (end > totalLen) break
    const data = buf.subarray(p + 8, end)
    if (chunkType === CHUNK_JSON) jsonChunk = data
    else if (chunkType === CHUNK_BIN) binChunk = data
    p = end
  }

  if (!jsonChunk) throw new Error('glb: missing JSON chunk')
  const json = JSON.parse(new TextDecoder().decode(jsonChunk)) as Record<string, unknown>
  return { json, bin: binChunk }
}

interface ImageDims {
  width: number
  height: number
  format: 'png' | 'jpeg' | 'ktx2'
}

/** Read one byte without tripping noUncheckedIndexedAccess. */
function at(buf: Uint8Array, i: number): number {
  return buf[i] ?? 0
}

function readImageDimensions(buf: Uint8Array): ImageDims | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width at 16, height at 20
  if (
    buf.byteLength >= 24 &&
    at(buf, 0) === 0x89 &&
    at(buf, 1) === 0x50 &&
    at(buf, 2) === 0x4e &&
    at(buf, 3) === 0x47
  ) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    return { width: dv.getUint32(16), height: dv.getUint32(20), format: 'png' }
  }
  // KTX2: AB 4B 54 58 20 32 30 BB ..., pixelWidth at 20, pixelHeight at 24 (LE)
  if (
    buf.byteLength >= 28 &&
    at(buf, 0) === 0xab &&
    at(buf, 1) === 0x4b &&
    at(buf, 2) === 0x54 &&
    at(buf, 3) === 0x58
  ) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    return {
      width: dv.getUint32(20, true),
      height: dv.getUint32(24, true),
      format: 'ktx2',
    }
  }
  // JPEG: FF D8, walk segments to an SOF marker (C0..C2)
  if (buf.byteLength >= 4 && at(buf, 0) === 0xff && at(buf, 1) === 0xd8) {
    let p = 2
    while (p + 9 < buf.byteLength) {
      if (at(buf, p) !== 0xff) {
        p++
        continue
      }
      const marker = buf[p + 1]
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc2) {
        const h = (at(buf, p + 5) << 8) | at(buf, p + 6)
        const w = (at(buf, p + 7) << 8) | at(buf, p + 8)
        return { width: w, height: h, format: 'jpeg' }
      }
      const segLen = (at(buf, p + 2) << 8) | at(buf, p + 3)
      if (segLen < 2) break
      p += 2 + segLen
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// glTF JSON shapes we touch
// ---------------------------------------------------------------------------

interface GltfAccessor {
  count?: number
}
interface GltfPrimitive {
  attributes?: Record<string, number>
  indices?: number
  mode?: number
}
interface GltfMesh {
  primitives?: GltfPrimitive[]
}
interface GltfImage {
  name?: string
  bufferView?: number
  uri?: string
  mimeType?: string
}
interface GltfBufferView {
  byteOffset?: number
  byteLength?: number
}
interface GltfTexture {
  extensions?: { KHR_texture_basisu?: { source?: number } }
}
interface GltfDoc {
  accessors?: GltfAccessor[]
  meshes?: GltfMesh[]
  images?: GltfImage[]
  bufferViews?: GltfBufferView[]
  textures?: GltfTexture[]
}

// ---------------------------------------------------------------------------
// analyzer
// ---------------------------------------------------------------------------

const TRIANGLES = 4
const TRIANGLE_STRIP = 5
const TRIANGLE_FAN = 6

export function analyzeGlb(buf: Uint8Array): GlbAnalysis {
  const { json, bin } = parseGlb(buf)
  const doc = json as GltfDoc
  const warnings: string[] = []
  const accessors = doc.accessors ?? []

  let drawCalls = 0
  let triangles = 0
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      drawCalls++
      const mode = prim.mode ?? TRIANGLES
      const idxCount = prim.indices !== undefined ? accessors[prim.indices]?.count : undefined
      const posCount =
        prim.attributes?.POSITION !== undefined
          ? accessors[prim.attributes.POSITION]?.count
          : undefined
      const count = idxCount ?? posCount ?? 0
      if (mode === TRIANGLES) {
        triangles += Math.floor(count / 3)
      } else if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) {
        triangles += Math.max(0, count - 2)
      } else if (count > 0) {
        warnings.push(`primitive mode ${mode} not counted as triangles (${count} vertices)`)
      }
    }
  }

  const compressedSources = new Set<number>()
  for (const tex of doc.textures ?? []) {
    const src = tex.extensions?.KHR_texture_basisu?.source
    if (src !== undefined) compressedSources.add(src)
  }

  const textures: TextureInfo[] = []
  let textureMemoryBytes = 0
  const bufferViews = doc.bufferViews ?? []
  const images = doc.images ?? []

  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (!img) continue

    const info: TextureInfo = {
      name: img.name ?? `image_${i}`,
      width: 0,
      height: 0,
      bytes: 0,
      compressed: false,
    }

    if (img.bufferView === undefined || !bin) {
      if (img.uri) warnings.push(`image ${info.name}: external URI, not measured`)
      else warnings.push(`image ${info.name}: no bufferView and no URI`)
      textures.push(info)
      continue
    }

    const bv = bufferViews[img.bufferView]
    if (!bv) {
      warnings.push(`image ${info.name}: bufferView ${img.bufferView} not found`)
      textures.push(info)
      continue
    }

    const start = bv.byteOffset ?? 0
    const imgBytes = bin.subarray(start, start + (bv.byteLength ?? 0))
    const dims = readImageDimensions(imgBytes)
    if (!dims) {
      warnings.push(`image ${info.name}: unsupported format ${img.mimeType ?? '?'}`)
      textures.push(info)
      continue
    }

    info.width = dims.width
    info.height = dims.height
    info.compressed = compressedSources.has(i) || dims.format === 'ktx2'
    const bpp = info.compressed ? 0.5 : 4
    info.bytes = Math.ceil(dims.width * dims.height * bpp * (4 / 3))
    textureMemoryBytes += info.bytes
    textures.push(info)
  }

  return { drawCalls, triangles, textureMemoryBytes, textures, warnings }
}

// ---------------------------------------------------------------------------
// budget check
// ---------------------------------------------------------------------------

export function checkRenderBudget(
  analysis: GlbAnalysis,
  budget: RenderBudget,
  subject: string,
): RenderViolation[] {
  const v: RenderViolation[] = []

  if (analysis.drawCalls > budget.maxDrawCalls) {
    v.push({
      id: 'render.drawCalls',
      subject,
      actual: analysis.drawCalls,
      limit: budget.maxDrawCalls,
      message: `${subject}: ${analysis.drawCalls} draw calls > ${budget.maxDrawCalls}`,
    })
  }

  if (analysis.triangles > budget.maxTriangles) {
    v.push({
      id: 'render.triangles',
      subject,
      actual: analysis.triangles,
      limit: budget.maxTriangles,
      message: `${subject}: ${analysis.triangles.toLocaleString('en-US')} triangles > ${budget.maxTriangles.toLocaleString('en-US')}`,
    })
  }

  const memMiB = analysis.textureMemoryBytes / (1024 * 1024)
  if (memMiB > budget.maxTextureMemoryMiB) {
    v.push({
      id: 'render.textureMemory',
      subject,
      actual: memMiB,
      limit: budget.maxTextureMemoryMiB,
      message: `${subject}: ${memMiB.toFixed(2)} MiB texture memory > ${budget.maxTextureMemoryMiB} MiB`,
    })
  }

  return v
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function pctStatus(actual: number, limit: number): string {
  const pct = limit > 0 ? Math.round((actual / limit) * 100) : 0
  return actual > limit ? `❌ ${pct}%` : `✅ ${pct}%`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function renderMarkdown(
  analysis: GlbAnalysis,
  budget: RenderBudget,
  violations: RenderViolation[],
  label: string,
): string {
  const L: string[] = []
  const memMiB = analysis.textureMemoryBytes / (1024 * 1024)

  L.push(`### Render budget — \`${label}\``)
  L.push('')
  L.push(
    `Target viewport **${budget.targetViewport.width}×${budget.targetViewport.height}** · ` +
      `target frame time **${budget.targetFrameTimeMs} ms** (manual — see \`docs/PERF.md\`)`,
  )
  L.push('')
  L.push('| Metric | Actual | Budget | Status |')
  L.push('|---|---:|---:|---:|')
  L.push(
    `| Draw calls | ${analysis.drawCalls} | ${budget.maxDrawCalls} | ${pctStatus(analysis.drawCalls, budget.maxDrawCalls)} |`,
  )
  L.push(
    `| Triangles | ${analysis.triangles.toLocaleString('en-US')} | ${budget.maxTriangles.toLocaleString('en-US')} | ${pctStatus(analysis.triangles, budget.maxTriangles)} |`,
  )
  L.push(
    `| Texture memory | ${memMiB.toFixed(2)} MiB | ${budget.maxTextureMemoryMiB} MiB | ${pctStatus(memMiB, budget.maxTextureMemoryMiB)} |`,
  )
  L.push(`| Frame time | — | ${budget.targetFrameTimeMs} ms | n/a (needs GPU) |`)
  L.push('')

  if (analysis.textures.length > 0) {
    L.push('<details><summary>Textures</summary>')
    L.push('')
    L.push('| Name | Size | Upload | Format |')
    L.push('|---|---:|---:|---|')
    for (const t of analysis.textures) {
      const fmt = t.compressed ? 'KTX2/BasisU' : 'RGBA8'
      const dims = t.width > 0 ? `${t.width}×${t.height}` : '—'
      const upload = t.bytes > 0 ? fmtBytes(t.bytes) : '—'
      L.push(`| \`${t.name}\` | ${dims} | ${upload} | ${fmt} |`)
    }
    L.push('')
    L.push('</details>')
    L.push('')
  }

  if (analysis.warnings.length > 0) {
    L.push('Warnings:')
    for (const w of analysis.warnings) L.push(`- ${w}`)
    L.push('')
  }

  if (violations.length > 0) {
    L.push(`❌ ${violations.length} render budget violation(s):`)
    for (const v of violations) L.push(`- ${v.message}`)
  } else {
    L.push('✅ Render budget met (static checks; frame time not verified).')
  }
  L.push('')
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultInput(root: string): string | null {
  for (const rel of ['examples/court/world.glb', 'examples/court/court.glb']) {
    const abs = path.join(root, rel)
    if (existsSync(abs)) return abs
  }
  return null
}

const HELP = `render-report — static GLB analysis against renderBudget

  --input <path.glb>   analyze this file (default: examples/court/world.glb)
  --budgets <path>     budgets file (default: scripts/size-budgets.json)
  --root <dir>         repo root (default: cwd)
  --json               machine-readable output
  --help
`

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return 0
  }

  const root = process.cwd()
  const json = argv.includes('--json')

  const inputIdx = argv.indexOf('--input')
  const budgetsIdx = argv.indexOf('--budgets')

  const budgetsArg = budgetsIdx >= 0 ? argv[budgetsIdx + 1] : undefined
  if (budgetsIdx >= 0 && budgetsArg === undefined) {
    console.error('render-report: --budgets requires a path')
    return 2
  }
  const budgetsPath = path.resolve(root, budgetsArg ?? 'scripts/size-budgets.json')

  const inputArg = inputIdx >= 0 ? argv[inputIdx + 1] : undefined
  if (inputIdx >= 0 && inputArg === undefined) {
    console.error('render-report: --input requires a path')
    return 2
  }
  const input = inputArg !== undefined ? path.resolve(root, inputArg) : defaultInput(root)

  if (!input) {
    console.log(
      'render-report: no input. Build the court (`npm run pack:court`) or pass --input <path.glb>.',
    )
    return 0
  }
  if (!existsSync(input)) {
    console.error(`render-report: input not found: ${input}`)
    return 2
  }

  const budget = loadRenderBudget(budgetsPath)
  const analysis = analyzeGlb(readFileSync(input))
  const violations = checkRenderBudget(analysis, budget, input)

  if (json) {
    console.log(JSON.stringify({ input, analysis, violations, budget }, null, 2))
  } else {
    console.log(renderMarkdown(analysis, budget, violations, input))
  }
  return violations.length > 0 ? 1 : 0
}

const invokedDirectly =
  process.argv[1] !== undefined && /render-report\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}