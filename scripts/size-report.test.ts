import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  checkBudgets,
  checkPhaseOneBudgets,
  checkSpecLimits,
  computeInitialFiles,
  formatBytes,
  measurePlayer,
  measureWorld,
  parseArgs,
  readZipDirectory,
  renderMarkdown,
  type Budgets,
  type SizeReport,
  type WorldReport,
  type ZipEntry,
} from './size-report.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal stored-only (method 0) ZIP writer, enough to exercise the reader. */
function makeStoredZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const name = enc.encode(e.name)
    const local = new Uint8Array(30 + name.length + e.data.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(8, 0, true) // stored
    dv.setUint32(18, e.data.length, true)
    dv.setUint32(22, e.data.length, true)
    dv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(e.data, 30 + name.length)
    chunks.push(local)

    const cen = new Uint8Array(46 + name.length)
    const cdv = new DataView(cen.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    cdv.setUint16(10, 0, true)
    cdv.setUint32(20, e.data.length, true)
    cdv.setUint32(24, e.data.length, true)
    cdv.setUint16(28, name.length, true)
    cdv.setUint32(42, offset, true)
    cen.set(name, 46)
    central.push(cen)

    offset += local.length
  }

  const cdSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(8, entries.length, true)
  edv.setUint16(10, entries.length, true)
  edv.setUint32(12, cdSize, true)
  edv.setUint32(16, offset, true)

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, p)
    p += c.length
  }
  return out
}

const BUDGETS: Budgets = {
  version: 4,
  worldTotalBytes: 1024,
  worldEntryBytes: { 'preview.png': 256 },
  worldEntryDefaultBytes: 512,
  playerInitialJsGzipBytes: 1024,
  playerDeferredChunkGzipBytes: 512,
  playerDistGzipBytes: 4096,
  playerRuntimeWasmGzipBytes: 0,
  renderBudget: {
    targetViewport: { width: 390, height: 844 },
    maxDrawCalls: 100,
    maxTriangles: 1000,
    maxTextureMemoryMiB: 4,
    targetFrameTimeMs: 16.7,
  },
  specLimits: {
    maxZipEntries: 8,
    maxEntryUncompressedBytes: 2048,
    maxCombinedUncompressedBytes: 4096,
    maxManifestUncompressedBytes: 1024,
    maxDeclarativeJsonUncompressedBytes: 1024,
    maxModelUncompressedBytes: 1024,
  },
}

// ---------------------------------------------------------------------------
// shared fixtures for the spec/phase-one split
// ---------------------------------------------------------------------------

const makeWorld = (over: Partial<WorldReport> = {}): WorldReport => ({
  path: 'test.wgif',
  sha256: 'x'.repeat(64),
  totalBytes: 100,
  transferBytes: 100,
  notes: [],
  entries: [],
  ...over,
})

const makeReport = (worlds: WorldReport[]): SizeReport => ({
  worlds,
  player: null,
  render: null,
  budgetsPath: 'scripts/size-budgets.json',
  duplicates: [],
  warnings: [],
})

const mkEntry = (name: string, expandedBytes: number, method: 0 | 8 = 0): ZipEntry => ({
  name,
  storedBytes: expandedBytes,
  expandedBytes,
  method,
  zip64: false,
})

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  it('renders bytes, KiB and MiB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1048576)).toBe('1.0 MiB')
  })
})

// ---------------------------------------------------------------------------
// readZipDirectory
// ---------------------------------------------------------------------------

describe('readZipDirectory', () => {
  it('reads names, stored and expanded sizes', () => {
    const zip = makeStoredZip([
      { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'preview.png', data: new Uint8Array(64) },
    ])
    const entries = readZipDirectory(zip)
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'preview.png'])
    const manifest = entries[0]
    const preview = entries[1]
    if (!manifest || !preview) throw new Error('expected two entries')
    expect(manifest.expandedBytes).toBe(7)
    expect(manifest.storedBytes).toBe(7)
    expect(manifest.method).toBe(0)
    expect(preview.expandedBytes).toBe(64)
  })

  it('rejects garbage', () => {
    expect(() => readZipDirectory(new Uint8Array(4))).toThrow(/too short|not a zip/)
    expect(() => readZipDirectory(new Uint8Array(1024))).toThrow(/end-of-central-directory/)
  })
})

// ---------------------------------------------------------------------------
// measureWorld
// ---------------------------------------------------------------------------

describe('measureWorld', () => {
  it('reports totals, transfer size and a hash', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wgif-size-'))
    const zip = makeStoredZip([
      { name: 'manifest.json', data: new TextEncoder().encode('{}') },
    ])
    writeFileSync(path.join(dir, 'tiny.wgif'), zip)
    const w = measureWorld(dir, 'tiny.wgif')
    expect(w.totalBytes).toBe(zip.byteLength)
    expect(w.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(w.transferBytes).toBeGreaterThan(0)
    expect(w.entries).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// checkBudgets
// ---------------------------------------------------------------------------

describe('checkBudgets', () => {
  const base = (over: Partial<SizeReport> = {}): SizeReport => ({
    worlds: [],
    player: null,
    render: null,
    budgetsPath: 'scripts/size-budgets.json',
    duplicates: [],
    warnings: [],
    ...over,
  })

  it('passes an empty report', () => {
    expect(checkBudgets(base(), BUDGETS)).toEqual([])
  })

  it('flags an oversized world and entry', () => {
    const report = base({
      worlds: [
        {
          path: 'examples/big/big.wgif',
          sha256: 'x'.repeat(64),
          totalBytes: 4096,
          transferBytes: 4000,
          notes: [],
          entries: [
            { name: 'preview.png', storedBytes: 300, expandedBytes: 300, method: 0, zip64: false },
            { name: 'world.glb', storedBytes: 900, expandedBytes: 900, method: 0, zip64: false },
          ],
        },
      ],
    })
    const ids = checkBudgets(report, BUDGETS).map((v) => v.id)
    expect(ids).toContain('world.total')
    expect(ids).toContain('world.entry:preview.png')
    expect(ids).toContain('world.entry:world.glb')
  })

  it('flags initial JS over budget, not deferred', () => {
    const report = base({
      player: {
        distDir: 'apps/player/dist',
        files: [],
        initial: [{ rel: 'assets/index-abc.js', bytes: 9000, gzip: 2048, brotli: 1500 }],
        deferred: [],
        jsGzip: 2048,
        jsInitialGzip: 2048,
        jsDeferredGzip: 0,
        wasmGzip: 0,
        totalGzip: 2048,
        manifestFound: true,
      },
    })
    const ids = checkBudgets(report, BUDGETS).map((v) => v.id)
    expect(ids).toContain('player.initial')
    expect(ids).not.toContain('player.deferredChunk')
  })

  it('flags a deferred chunk over its per-chunk budget', () => {
    const report = base({
      player: {
        distDir: 'apps/player/dist',
        files: [],
        initial: [],
        deferred: [{ rel: 'assets/lazy-xyz.js', bytes: 4000, gzip: 900, brotli: 800 }],
        jsGzip: 900,
        jsInitialGzip: 0,
        jsDeferredGzip: 900,
        wasmGzip: 0,
        totalGzip: 900,
        manifestFound: true,
      },
    })
    const ids = checkBudgets(report, BUDGETS).map((v) => v.id)
    expect(ids).toContain('player.deferredChunk')
    expect(ids).not.toContain('player.initial')
  })

  it('flags runtime WASM under a 0-byte Phase One budget', () => {
    const report = base({
      player: {
        distDir: 'apps/player/dist',
        files: [],
        initial: [],
        deferred: [],
        jsGzip: 0,
        jsInitialGzip: 0,
        jsDeferredGzip: 0,
        wasmGzip: 5000,
        totalGzip: 0,
        manifestFound: true,
      },
    })
    const ids = checkBudgets(report, BUDGETS).map((v) => v.id)
    expect(ids).toContain('player.wasm')
  })

  it('folds render budget violations into the report with phase-one severity', () => {
    const report = base({
      render: {
        label: 'court.glb',
        analysis: {
          drawCalls: BUDGETS.renderBudget.maxDrawCalls + 1,
          triangles: 0,
          textureMemoryBytes: 0,
          textures: [],
          warnings: [],
        },
      },
    })
    const violations = checkBudgets(report, BUDGETS)
    const renderV = violations.find((v) => v.id === 'render.drawCalls')
    expect(renderV).toBeDefined()
    expect(renderV?.severity).toBe('phase-one')
  })

  it('does not add render violations when report.render is null', () => {
    const ids = checkBudgets(base({ render: null }), BUDGETS).map((v) => v.id)
    expect(ids.filter((id) => id.startsWith('render.'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkSpecLimits — docs/spec/wgif-v0.1.md §2 + §6 (MUST, reader refuses)
// ---------------------------------------------------------------------------

describe('checkSpecLimits', () => {
  const L = BUDGETS.specLimits

  it('passes an empty report', () => {
    expect(checkSpecLimits(makeReport([]), L)).toEqual([])
  })

  it('flags too many ZIP entries (§2)', () => {
    const entries = Array.from({ length: L.maxZipEntries + 1 }, (_, i) => mkEntry(`f${i}.json`, 1))
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids).toContain('spec.entries')
  })

  it('flags an entry over the per-entry uncompressed ceiling (§2)', () => {
    const entries = [mkEntry('world.glb', L.maxEntryUncompressedBytes + 1)]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids).toContain('spec.entry:world.glb')
  })

  it('flags combined uncompressed bytes over the ceiling (§2)', () => {
    const entries = [
      mkEntry('world.glb', L.maxEntryUncompressedBytes),
      mkEntry('preview.png', 2048),
    ]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids).toContain('spec.combined')
  })

  it('flags manifest.json over the manifest ceiling (§2)', () => {
    const entries = [mkEntry('manifest.json', L.maxManifestUncompressedBytes + 1)]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids).toContain('spec.manifest')
  })

  it('flags an oversized declarative JSON payload (§2)', () => {
    const entries = [mkEntry('interactions.json', L.maxDeclarativeJsonUncompressedBytes + 1)]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids).toContain('spec.json:interactions.json')
  })

  it('flags a model over 1 MiB under models/ (§6)', () => {
    const entries = [mkEntry('models/rebounder.onnx', L.maxModelUncompressedBytes + 1)]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids).toContain('spec.model:models/rebounder.onnx')
  })

  it('does not double-report manifest.json as a declarative JSON payload', () => {
    const entries = [mkEntry('manifest.json', L.maxDeclarativeJsonUncompressedBytes + 1)]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids.some((id) => id.startsWith('spec.json:manifest'))).toBe(false)
  })

  it('does not flag models/ entries as declarative JSON', () => {
    const entries = [mkEntry('models/weights.json', L.maxDeclarativeJsonUncompressedBytes + 1)]
    const ids = checkSpecLimits(makeReport([makeWorld({ entries })]), L).map((v) => v.id)
    expect(ids.some((id) => id.startsWith('spec.json:models'))).toBe(false)
  })

  it('tags every violation with severity "spec"', () => {
    const entries = [mkEntry('manifest.json', L.maxManifestUncompressedBytes + 1)]
    const violations = checkSpecLimits(makeReport([makeWorld({ entries })]), L)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((v) => v.severity === 'spec')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// checkPhaseOneBudgets — docs/BUDGETS.md (SHOULD, optimization targets)
// ---------------------------------------------------------------------------

describe('checkPhaseOneBudgets', () => {
  it('passes an empty report', () => {
    expect(checkPhaseOneBudgets(makeReport([]), BUDGETS)).toEqual([])
  })

  it('flags a world over the Phase One total target', () => {
    const w = makeWorld({ totalBytes: BUDGETS.worldTotalBytes + 1 })
    const ids = checkPhaseOneBudgets(makeReport([w]), BUDGETS).map((v) => v.id)
    expect(ids).toContain('world.total')
  })

  it('does not flag entry count — that is a spec check, not a Phase One one', () => {
    const entries = Array.from({ length: 9 }, (_, i) => mkEntry(`f${i}.json`, 1))
    const ids = checkPhaseOneBudgets(makeReport([makeWorld({ entries })]), BUDGETS).map((v) => v.id)
    expect(ids.filter((id) => id === 'world.entries')).toEqual([])
  })

  it('tags every violation with severity "phase-one"', () => {
    const w = makeWorld({ totalBytes: BUDGETS.worldTotalBytes + 1 })
    const violations = checkPhaseOneBudgets(makeReport([w]), BUDGETS)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((v) => v.severity === 'phase-one')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeInitialFiles
// ---------------------------------------------------------------------------

describe('computeInitialFiles', () => {
  it('follows static imports, not dynamic imports', () => {
    const initial = computeInitialFiles({
      'index.html': {
        file: 'assets/index-abc.js',
        isEntry: true,
        imports: ['_shared.js'],
        dynamicImports: ['src/lazy.ts'],
      },
      '_shared.js': { file: 'assets/shared-xyz.js' },
      'src/lazy.ts': { file: 'assets/lazy-xyz.js', isDynamicEntry: true },
    })
    expect([...initial].sort()).toEqual(['assets/index-abc.js', 'assets/shared-xyz.js'])
    expect(initial.has('assets/lazy-xyz.js')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// measurePlayer
// ---------------------------------------------------------------------------

describe('measurePlayer', () => {
  it('separates initial and deferred JS via the Vite manifest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wgif-dist-'))
    mkdirSync(path.join(dir, '.vite'), { recursive: true })
    mkdirSync(path.join(dir, 'assets'), { recursive: true })
    writeFileSync(
      path.join(dir, '.vite', 'manifest.json'),
      JSON.stringify({
        'index.html': {
          file: 'assets/index-abc.js',
          isEntry: true,
          imports: ['_shared.js'],
          dynamicImports: ['src/lazy.ts'],
        },
        '_shared.js': { file: 'assets/shared-xyz.js' },
        'src/lazy.ts': { file: 'assets/lazy-xyz.js', isDynamicEntry: true },
      }),
    )
    writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'const a=1;'.repeat(100))
    writeFileSync(path.join(dir, 'assets', 'shared-xyz.js'), 'const b=2;'.repeat(50))
    writeFileSync(path.join(dir, 'assets', 'lazy-xyz.js'), 'const c=3;'.repeat(200))
    const p = measurePlayer(dir)
    expect(p).not.toBeNull()
    expect(p!.manifestFound).toBe(true)
    expect(p!.initial.map((f) => f.rel).sort()).toEqual([
      'assets/index-abc.js',
      'assets/shared-xyz.js',
    ])
    expect(p!.deferred.map((f) => f.rel)).toEqual(['assets/lazy-xyz.js'])
    expect(p!.jsInitialGzip + p!.jsDeferredGzip).toBe(p!.jsGzip)
  })

  it('falls back to "all JS is initial" without a manifest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wgif-dist-nomanifest-'))
    mkdirSync(path.join(dir, 'assets'), { recursive: true })
    writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'const a=1;')
    const p = measurePlayer(dir)
    expect(p).not.toBeNull()
    expect(p!.manifestFound).toBe(false)
    expect(p!.initial.map((f) => f.rel)).toEqual(['assets/index-abc.js'])
    expect(p!.deferred).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('includes the world path and a verdict', () => {
    const md = renderMarkdown(
      {
        worlds: [
          {
            path: 'examples/court/court.wgif',
            sha256: 'x'.repeat(64),
            totalBytes: 30_000,
            transferBytes: 29_000,
            notes: [],
            entries: [
              {
                name: 'manifest.json',
                storedBytes: 900,
                expandedBytes: 900,
                method: 0,
                zip64: false,
              },
            ],
          },
        ],
        player: null,
        render: null,
        budgetsPath: 'scripts/size-budgets.json',
        duplicates: [],
        warnings: [],
      },
      { ...BUDGETS, worldTotalBytes: 1_048_576 },
      [],
    )
    expect(md).toContain('examples/court/court.wgif')
    expect(md).toContain('All budgets met')
  })

  it('renders a render budget section when report.render is present', () => {
    const md = renderMarkdown(
      {
        worlds: [],
        player: null,
        render: {
          label: 'court.glb',
          analysis: {
            drawCalls: 3,
            triangles: 100,
            textureMemoryBytes: 0,
            textures: [],
            warnings: [],
          },
        },
        budgetsPath: 'scripts/size-budgets.json',
        duplicates: [],
        warnings: [],
      },
      BUDGETS,
      [],
    )
    expect(md).toContain('Render budget')
    expect(md).toContain('court.glb')
    expect(md).toContain('Draw calls')
  })
})

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('applies defaults and overrides', () => {
    const d = parseArgs([], '/repo')
    expect(d.root).toBe('/repo')
    expect(d.dist).toBe('apps/player/dist')
    const o = parseArgs(['--soft', '--summary', 'out.md'], '/repo')
    expect(o.soft).toBe(true)
    expect(o.summaryPath).toBe('out.md')
    expect(() => parseArgs(['--nope'], '/repo')).toThrow(/unknown argument/)
  })
})

// ---------------------------------------------------------------------------
// real worlds in this repo
// ---------------------------------------------------------------------------

describe('real worlds in this repo', () => {
  const candidates = ['examples/court/court.wgif', '../examples/court/court.wgif'].map((p) =>
    path.resolve(process.cwd(), p),
  )
  const court = candidates.find((p) => existsSync(p))

  it.skipIf(!court)('court.wgif has manifest.json as its first entry', () => {
    if (!court) return
    const buf = readFileSync(court)
    const entries = readZipDirectory(buf)
    expect(entries[0]?.name).toBe('manifest.json')
    expect(entries.every((e) => e.expandedBytes >= 0)).toBe(true)
  })
})