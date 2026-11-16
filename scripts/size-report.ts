#!/usr/bin/env node
/**
 * WGIF size report (Dee / OPTIMIZATION lane).
 *
 * Unpacks every .wgif in the repo and measures apps/player/dist, then prints
 * per-file raw + gzip + brotli sizes against scripts/size-budgets.json.
 *
 * The ZIP directory is parsed directly (no decompression) so we can report
 * BOTH the bytes shipped inside the container and the bytes a player must
 * hold in memory after inflating. Worlds that fail validation are still
 * measurable, which is the point: size is a property of the file, not of
 * whether the manifest happens to be correct today.
 *
 * Usage:
 *   tsx scripts/size-report.ts [--root .] [--dist apps/player/dist]
 *                              [--budgets scripts/size-budgets.json]
 *                              [--json] [--summary <file>] [--soft] [--strict]
 *
 * Exit code 1 when any budget is exceeded (unless --soft).
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

export interface Budgets {
  version: number
  worldTotalBytes: number
  worldMaxEntries: number
  worldEntryBytes: Record<string, number>
  worldEntryDefaultBytes: number
  playerJsGzipBytes: number
  playerChunkGzipBytes: number
  playerDistGzipBytes: number
}

export function loadBudgets(absPath: string): Budgets {
  const raw = JSON.parse(readFileSync(absPath, 'utf8')) as Partial<Budgets>
  const required: (keyof Budgets)[] = [
    'worldTotalBytes',
    'worldMaxEntries',
    'worldEntryBytes',
    'worldEntryDefaultBytes',
    'playerJsGzipBytes',
    'playerChunkGzipBytes',
    'playerDistGzipBytes',
  ]
  for (const key of required) {
    if (raw[key] === undefined) throw new Error(`budgets: missing key "${key}" in ${absPath}`)
  }
  return raw as Budgets
}

// ---------------------------------------------------------------------------
// zip directory reader (central directory only; no decompression)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

export interface ZipEntry {
  name: string
  /** Bytes the entry occupies inside the .wgif container. */
  storedBytes: number
  /** Bytes after decompression: what the player must hold in memory. */
  expandedBytes: number
  /** 0 = stored, 8 = deflate. */
  method: number
  zip64: boolean
  /** Offset of the local file header. Populated by readZipDirectory; unused by the size report itself. */
  localHeaderOffset?: number
}

export function readZipDirectory(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.byteLength < 22) throw new Error('not a zip: shorter than an EOCD record')

  // Scan backwards for the end-of-central-directory record (comment is <= 64 KiB).
  let eocd = -1
  const stop = Math.max(0, buf.byteLength - 22 - 0xffff)
  for (let i = buf.byteLength - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')

  const totalEntries = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  if (cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported by size-report')

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.byteLength) throw new Error('truncated central directory')
    if (dv.getUint32(p, true) !== CEN_SIG) throw new Error(`bad central directory signature at ${p}`)

    const method = dv.getUint16(p + 10, true)
    const compressed = dv.getUint32(p + 20, true)
    const uncompressed = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
    const zip64 = compressed === 0xffffffff || uncompressed === 0xffffffff

    entries.push({
      name,
      storedBytes: compressed,
      expandedBytes: uncompressed,
      method,
      zip64,
      localHeaderOffset: dv.getUint32(p + 42, true),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ---------------------------------------------------------------------------
// measurement primitives
// ---------------------------------------------------------------------------

/** gzip at level 9 so the number is stable run-to-run regardless of host zlib. */
export function gzipBytes(buf: Uint8Array): number {
  return gzipSync(buf, { level: 9 }).byteLength
}

/** Brotli q9: close to CDN reality without the multi-second q11 cost on 1 MiB. */
export function brotliBytes(buf: Uint8Array): number {
  return brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
    },
  }).byteLength
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return 'n/a'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Truly entropy-coded payloads: re-deflating them costs open-time CPU for ~0%
 * saving, so they SHOULD be stored (method 0).
 * Not on this list: .glb/.gltf. A GLB is a binary container, not a compressed
 * stream — deflate it normally.
 */
const PRECOMPRESSED =
  /\.(png|jpe?g|webp|avif|ktx2|mp3|ogg|opus|mp4|webm|woff2?|zip|gz|br)$/i

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.vite', '.turbo'])

export function findFiles(root: string, match: (rel: string) => boolean): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), childRel)
      } else if (d.isFile() && match(childRel)) {
        out.push(childRel)
      }
    }
  }
  walk(root, '')
  return out.sort()
}

// ---------------------------------------------------------------------------
// report model
// ---------------------------------------------------------------------------

export interface WorldReport {
  path: string
  sha256: string
  totalBytes: number
  /** Brotli of the whole .wgif: what a host or chat app would actually transfer. */
  transferBytes: number
  entries: ZipEntry[]
  notes: string[]
}

export interface DistFile {
  rel: string
  bytes: number
  gzip: number
  brotli: number
}

export interface PlayerReport {
  distDir: string
  files: DistFile[]
  jsGzip: number
  totalGzip: number
}

export interface Violation {
  id: string
  subject: string
  actual: number
  limit: number
  message: string
}

export interface SizeReport {
  worlds: WorldReport[]
  player: PlayerReport | null
  budgetsPath: string
  duplicates: string[]
  warnings: string[]
}

export function measureWorld(root: string, rel: string): WorldReport {
  const abs = path.join(root, rel)
  const buf = readFileSync(abs)
  const entries = readZipDirectory(buf)
  const notes: string[] = []

  const wasteful = entries.filter((e) => e.method === 8 && PRECOMPRESSED.test(e.name))
  if (wasteful.length > 0) {
    notes.push(
      `stored deflated: ${wasteful.map((e) => e.name).join(', ')} — already-compressed format, ` +
        'store it (method 0) to save open-time CPU at ~0% size cost',
    )
  }
  const largest = [...entries].sort((a, b) => b.expandedBytes - a.expandedBytes)[0]
  if (largest) notes.push(`largest entry: ${largest.name} (${formatBytes(largest.expandedBytes)} expanded)`)

  return {
    path: rel,
    sha256: createHash('sha256').update(buf).digest('hex'),
    totalBytes: buf.byteLength,
    transferBytes: brotliBytes(buf),
    entries,
    notes,
  }
}

export function measurePlayer(distDir: string): PlayerReport | null {
  if (!existsSync(distDir)) return null
  const rels = findFiles(distDir, () => true)
  const files: DistFile[] = []
  for (const rel of rels) {
    const buf = readFileSync(path.join(distDir, rel))
    files.push({ rel, bytes: buf.byteLength, gzip: gzipBytes(buf), brotli: brotliBytes(buf) })
  }
  // Source maps are not shipped to players; report them but exclude from totals.
  const shipped = files.filter((f) => !f.rel.endsWith('.map'))
  return {
    distDir,
    files,
    jsGzip: shipped.filter((f) => f.rel.endsWith('.js')).reduce((a, f) => a + f.gzip, 0),
    totalGzip: shipped.reduce((a, f) => a + f.gzip, 0),
  }
}

export function checkBudgets(report: SizeReport, budgets: Budgets): Violation[] {
  const v: Violation[] = []

  for (const w of report.worlds) {
    if (w.totalBytes > budgets.worldTotalBytes) {
      v.push({
        id: 'world.total',
        subject: w.path,
        actual: w.totalBytes,
        limit: budgets.worldTotalBytes,
        message: `${w.path}: ${formatBytes(w.totalBytes)} > ${formatBytes(budgets.worldTotalBytes)}`,
      })
    }
    if (w.entries.length > budgets.worldMaxEntries) {
      v.push({
        id: 'world.entries',
        subject: w.path,
        actual: w.entries.length,
        limit: budgets.worldMaxEntries,
        message: `${w.path}: ${w.entries.length} entries > ${budgets.worldMaxEntries}`,
      })
    }
    for (const e of w.entries) {
      const limit = budgets.worldEntryBytes[e.name] ?? budgets.worldEntryDefaultBytes
      if (e.expandedBytes > limit) {
        v.push({
          id: `world.entry:${e.name}`,
          subject: w.path,
          actual: e.expandedBytes,
          limit,
          message: `${w.path} → ${e.name}: ${formatBytes(e.expandedBytes)} > ${formatBytes(limit)}`,
        })
      }
    }
  }

  if (report.player) {
    const p = report.player
    if (p.jsGzip > budgets.playerJsGzipBytes) {
      v.push({
        id: 'player.js',
        subject: p.distDir,
        actual: p.jsGzip,
        limit: budgets.playerJsGzipBytes,
        message: `player JS ${formatBytes(p.jsGzip)} gzip > ${formatBytes(budgets.playerJsGzipBytes)}`,
      })
    }
    for (const f of p.files) {
      if (!f.rel.endsWith('.js') || f.gzip <= budgets.playerChunkGzipBytes) continue
      v.push({
        id: 'player.chunk',
        subject: f.rel,
        actual: f.gzip,
        limit: budgets.playerChunkGzipBytes,
        message: `chunk ${f.rel}: ${formatBytes(f.gzip)} gzip > ${formatBytes(budgets.playerChunkGzipBytes)}`,
      })
    }
    if (p.totalGzip > budgets.playerDistGzipBytes) {
      v.push({
        id: 'player.dist',
        subject: p.distDir,
        actual: p.totalGzip,
        limit: budgets.playerDistGzipBytes,
        message: `player dist ${formatBytes(p.totalGzip)} gzip > ${formatBytes(budgets.playerDistGzipBytes)}`,
      })
    }
  }

  return v
}

export function buildReport(opts: { root: string; dist: string; budgetsPath: string }): SizeReport {
  const warnings: string[] = []
  const duplicates: string[] = []

  // Prefer the canonical copy over the one baked into the player's dist.
  const wgifRels = findFiles(opts.root, (rel) => rel.endsWith('.wgif')).sort((a, b) => {
    const ad = a.includes('/dist/') ? 1 : 0
    const bd = b.includes('/dist/') ? 1 : 0
    return ad - bd || a.localeCompare(b)
  })

  const seen = new Map<string, string>()
  const worlds: WorldReport[] = []
  for (const rel of wgifRels) {
    let world: WorldReport
    try {
      world = measureWorld(opts.root, rel)
    } catch (err) {
      warnings.push(`${rel}: ${(err as Error).message}`)
      continue
    }
    const first = seen.get(world.sha256)
    if (first) {
      duplicates.push(`${rel} (identical to ${first})`)
      continue
    }
    seen.set(world.sha256, rel)
    worlds.push(world)
  }

  const player = measurePlayer(path.join(opts.root, opts.dist))
  if (!player) warnings.push(`player dist not found at ${opts.dist} — run \`npm run build\` first`)

  return { worlds, player, budgetsPath: opts.budgetsPath, duplicates, warnings }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function status(actual: number, limit: number): string {
  const pct = limit > 0 ? (actual / limit) * 100 : 0
  return actual > limit ? `❌ ${pct.toFixed(0)}%` : `✅ ${pct.toFixed(0)}%`
}

export function renderMarkdown(report: SizeReport, budgets: Budgets, violations: Violation[]): string {
  const L: string[] = []
  L.push('## WGIF size report')
  L.push('')
  L.push(`Budgets: \`${report.budgetsPath}\` · documented in \`docs/BUDGETS.md\``)
  L.push('')

  L.push('### Worlds')
  L.push('')
  if (report.worlds.length === 0) {
    L.push('_No .wgif files found._')
  } else {
    L.push('| World | In container | Budget | Status | Expanded | Transfer (brotli) |')
    L.push('|---|---:|---:|---:|---:|---:|')
    for (const w of report.worlds) {
      const expanded = w.entries.reduce((a, e) => a + e.expandedBytes, 0)
      L.push(
        `| \`${w.path}\` | ${formatBytes(w.totalBytes)} | ${formatBytes(budgets.worldTotalBytes)} | ` +
          `${status(w.totalBytes, budgets.worldTotalBytes)} | ${formatBytes(expanded)} | ${formatBytes(w.transferBytes)} |`,
      )
    }
    L.push('')
    for (const w of report.worlds) {
      L.push(`<details><summary><code>${w.path}</code> — ${w.entries.length} entries</summary>`)
      L.push('')
      L.push('| Entry | Method | Stored | Expanded | Budget | Status |')
      L.push('|---|---|---:|---:|---:|---:|')
      for (const e of w.entries) {
        const limit = budgets.worldEntryBytes[e.name] ?? budgets.worldEntryDefaultBytes
        L.push(
          `| \`${e.name}\` | ${e.method === 8 ? 'deflate' : e.method === 0 ? 'store' : e.method} | ` +
            `${formatBytes(e.storedBytes)} | ${formatBytes(e.expandedBytes)} | ${formatBytes(limit)} | ` +
            `${status(e.expandedBytes, limit)} |`,
        )
      }
      L.push('')
      for (const n of w.notes) L.push(`- ${n}`)
      L.push('')
      L.push('</details>')
      L.push('')
    }
  }

  L.push('### Player bundle')
  L.push('')
  if (!report.player) {
    L.push('_Player dist not measured._')
  } else {
    const p = report.player
    L.push(`Total JS (gzip): **${formatBytes(p.jsGzip)}** / ${formatBytes(budgets.playerJsGzipBytes)} — ${status(p.jsGzip, budgets.playerJsGzipBytes)}`)
    L.push('')
    L.push(`Total dist (gzip, excluding .map): **${formatBytes(p.totalGzip)}** / ${formatBytes(budgets.playerDistGzipBytes)} — ${status(p.totalGzip, budgets.playerDistGzipBytes)}`)
    L.push('')
    const top = [...p.files].filter((f) => !f.rel.endsWith('.map')).sort((a, b) => b.gzip - a.gzip).slice(0, 12)
    L.push('| File | Raw | gzip | brotli |')
    L.push('|---|---:|---:|---:|')
    for (const f of top) L.push(`| \`${f.rel}\` | ${formatBytes(f.bytes)} | ${formatBytes(f.gzip)} | ${formatBytes(f.brotli)} |`)
  }

  if (report.duplicates.length > 0) {
    L.push('')
    L.push('### Duplicate worlds (skipped)')
    L.push('')
    for (const d of report.duplicates) L.push(`- ${d}`)
  }
  if (report.warnings.length > 0) {
    L.push('')
    L.push('### Warnings')
    L.push('')
    for (const w of report.warnings) L.push(`- ${w}`)
  }

  L.push('')
  L.push(violations.length === 0 ? '### ✅ All budgets met' : `### ❌ ${violations.length} budget violation(s)`)
  if (violations.length > 0) {
    L.push('')
    for (const x of violations) L.push(`- **${x.id}** — ${x.message}`)
  }
  L.push('')
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface Options {
  root: string
  dist: string
  budgetsPath: string
  json: boolean
  summaryPath: string | null
  soft: boolean
  strict: boolean
}

export function parseArgs(argv: string[], cwd: string): Options {
  const o: Options = {
    root: cwd,
    dist: 'apps/player/dist',
    budgetsPath: 'scripts/size-budgets.json',
    json: false,
    summaryPath: null,
    soft: false,
    strict: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} requires a value`)
      return v
    }
    switch (a) {
      case '--root': o.root = path.resolve(cwd, next()); break
      case '--dist': o.dist = next(); break
      case '--budgets': o.budgetsPath = next(); break
      case '--json': o.json = true; break
      case '--summary': o.summaryPath = next(); break
      case '--soft': o.soft = true; break
      case '--strict': o.strict = true; break
      case '-h':
      case '--help': o.json = false; o.root = '__help__'; break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  return o
}

const HELP = `size-report — WGIF size budgets

  --root <dir>      repo root (default: cwd)
  --dist <dir>      player dist, relative to root (default: apps/player/dist)
  --budgets <file>  budgets JSON, relative to root (default: scripts/size-budgets.json)
  --json            machine-readable output
  --summary <file>  also append a markdown section (use $GITHUB_STEP_SUMMARY in CI)
  --soft            never exit non-zero
  --strict          exit non-zero if the player dist is missing
`

export function main(argv: string[], cwd: string): number {
  let opts: Options
  try {
    opts = parseArgs(argv, cwd)
  } catch (err) {
    console.error((err as Error).message)
    return 2
  }
  if (opts.root === '__help__') {
    console.log(HELP)
    return 0
  }

  const budgetsAbs = path.resolve(opts.root, opts.budgetsPath)
  const budgets = loadBudgets(budgetsAbs)
  const report = buildReport({ root: opts.root, dist: opts.dist, budgetsPath: opts.budgetsPath })
  const violations = checkBudgets(report, budgets)

  if (opts.json) {
    console.log(JSON.stringify({ report, budgets, violations }, null, 2))
  } else {
    for (const w of report.worlds) {
      console.log(`${w.path}: ${formatBytes(w.totalBytes)} (budget ${formatBytes(budgets.worldTotalBytes)})`)
      for (const e of w.entries) {
        const limit = budgets.worldEntryBytes[e.name] ?? budgets.worldEntryDefaultBytes
        console.log(`  ${e.name.padEnd(28)} ${formatBytes(e.expandedBytes).padStart(10)}  / ${formatBytes(limit)}`)
      }
      for (const n of w.notes) console.log(`  · ${n}`)
    }
    if (report.player) {
      console.log(
        `player JS: ${formatBytes(report.player.jsGzip)} gzip / ${formatBytes(budgets.playerJsGzipBytes)}` +
          `  ·  dist: ${formatBytes(report.player.totalGzip)} gzip`,
      )
    }
    for (const w of report.warnings) console.log(`warning: ${w}`)
    console.log(violations.length === 0 ? 'all budgets met' : `${violations.length} violation(s):`)
    for (const x of violations) console.log(`  ✗ ${x.message}`)
  }

  if (opts.summaryPath) {
    appendFileSync(opts.summaryPath, renderMarkdown(report, budgets, violations) + '\n')
  }

  if (!report.player && opts.strict) return 1
  if (violations.length > 0 && !opts.soft) return 1
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && /size-report\.(ts|js|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), process.cwd())
}