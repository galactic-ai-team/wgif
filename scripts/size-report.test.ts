import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkBudgets,
  formatBytes,
  measureWorld,
  parseArgs,
  readZipDirectory,
  renderMarkdown,
  type Budgets,
  type SizeReport,
} from './size-report'

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
  version: 1,
  worldTotalBytes: 1024,
  worldMaxEntries: 8,
  worldEntryBytes: { 'preview.png': 256 },
  worldEntryDefaultBytes: 512,
  playerJsGzipBytes: 1024,
  playerChunkGzipBytes: 512,
  playerDistGzipBytes: 4096,
}

describe('formatBytes', () => {
  it('renders bytes, KiB and MiB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1048576)).toBe('1.0 MiB')
  })
})

describe('readZipDirectory', () => {
  it('reads names, stored and expanded sizes', () => {
    const zip = makeStoredZip([
      { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'preview.png', data: new Uint8Array(64) },
    ])
    const entries = readZipDirectory(zip)
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'preview.png'])
    expect(entries[0].expandedBytes).toBe(7)
    expect(entries[0].storedBytes).toBe(7)
    expect(entries[0].method).toBe(0)
    expect(entries[1].expandedBytes).toBe(64)
  })

  it('rejects garbage', () => {
    expect(() => readZipDirectory(new Uint8Array(4))).toThrow(/too short|not a zip/)
    expect(() => readZipDirectory(new Uint8Array(1024))).toThrow(/end-of-central-directory/)
  })
})

describe('measureWorld', () => {
  it('reports totals, transfer size and a hash', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wgif-size-'))
    const zip = makeStoredZip([{ name: 'manifest.json', data: new TextEncoder().encode('{}') }])
    writeFileSync(path.join(dir, 'tiny.wgif'), zip)
    const w = measureWorld(dir, 'tiny.wgif')
    expect(w.totalBytes).toBe(zip.byteLength)
    expect(w.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(w.transferBytes).toBeGreaterThan(0)
    expect(w.entries).toHaveLength(1)
  })
})

describe('checkBudgets', () => {
  const base = (over: Partial<SizeReport> = {}): SizeReport => ({
    worlds: [],
    player: null,
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

  it('flags player JS and oversized chunks', () => {
    const report = base({
      player: {
        distDir: 'apps/player/dist',
        jsGzip: 2048,
        totalGzip: 2048,
        files: [{ rel: 'assets/index-abc.js', bytes: 9000, gzip: 2048, brotli: 1500 }],
      },
    })
    const ids = checkBudgets(report, BUDGETS).map((v) => v.id)
    expect(ids).toContain('player.js')
    expect(ids).toContain('player.chunk')
  })
})

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
            entries: [{ name: 'manifest.json', storedBytes: 900, expandedBytes: 900, method: 0, zip64: false }],
          },
        ],
        player: null,
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
})

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

describe('real worlds in this repo', () => {
  const candidates = ['examples/court/court.wgif', '../examples/court/court.wgif'].map((p) =>
    path.resolve(process.cwd(), p),
  )
  const court = candidates.find((p) => existsSync(p))

  it.skipIf(!court)('court.wgif has manifest.json as its first entry', () => {
    const buf = readFileSync(court as string)
    const entries = readZipDirectory(buf)
    expect(entries[0]?.name).toBe('manifest.json')
    expect(entries.every((e) => e.expandedBytes >= 0)).toBe(true)
  })
})