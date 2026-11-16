import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  analyzeGlb,
  checkRenderBudget,
  loadRenderBudget,
  renderMarkdown,
  type GlbAnalysis,
  type RenderBudget,
} from './render-report.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BUDGET: RenderBudget = {
  targetViewport: { width: 390, height: 844 },
  maxDrawCalls: 10,
  maxTriangles: 100,
  maxTextureMemoryMiB: 1,
  targetFrameTimeMs: 16.7,
}

const emptyAnalysis = (over: Partial<GlbAnalysis> = {}): GlbAnalysis => ({
  drawCalls: 0,
  triangles: 0,
  textureMemoryBytes: 0,
  textures: [],
  warnings: [],
  ...over,
})

function padTo4(data: Uint8Array, fill: number): Uint8Array {
  const pad = (4 - (data.length % 4)) % 4
  if (pad === 0) return data
  const out = new Uint8Array(data.length + pad)
  out.set(data)
  out.fill(fill, data.length)
  return out
}

function buildGlb(json: object, bin: Uint8Array | null): Uint8Array {
  const jsonPadded = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binPadded = bin ? padTo4(bin, 0x00) : null
  let totalLen = 12 + 8 + jsonPadded.length
  if (binPadded) totalLen += 8 + binPadded.length
  const out = new Uint8Array(totalLen)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, totalLen, true)
  let p = 12
  dv.setUint32(p, jsonPadded.length, true)
  dv.setUint32(p + 4, 0x4e4f534a, true)
  out.set(jsonPadded, p + 8)
  p += 8 + jsonPadded.length
  if (binPadded) {
    dv.setUint32(p, binPadded.length, true)
    dv.setUint32(p + 4, 0x004e4942, true)
    out.set(binPadded, p + 8)
  }
  return out
}

function fakePng(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(24)
  const dv = new DataView(buf.buffer)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  buf[4] = 0x0d
  buf[5] = 0x0a
  buf[6] = 0x1a
  buf[7] = 0x0a
  dv.setUint32(8, 13)
  buf[12] = 0x49
  buf[13] = 0x48
  buf[14] = 0x44
  buf[15] = 0x52
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  return buf
}

// ---------------------------------------------------------------------------
// loadRenderBudget
// ---------------------------------------------------------------------------

describe('loadRenderBudget', () => {
  function writeBudgets(payload: object): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'render-budget-'))
    const file = path.join(dir, 'budgets.json')
    writeFileSync(file, JSON.stringify(payload))
    return file
  }

  it('returns the renderBudget block', () => {
    const file = writeBudgets({ renderBudget: BUDGET })
    expect(loadRenderBudget(file)).toEqual(BUDGET)
  })

  it('throws when renderBudget is missing', () => {
    const file = writeBudgets({})
    expect(() => loadRenderBudget(file)).toThrow(/no "renderBudget"/)
  })

  it('throws when a required field is missing', () => {
    const partial = { ...BUDGET } as Partial<RenderBudget>
    delete partial.maxDrawCalls
    const file = writeBudgets({ renderBudget: partial })
    expect(() => loadRenderBudget(file)).toThrow(/missing "maxDrawCalls"/)
  })
})

// ---------------------------------------------------------------------------
// analyzeGlb
// ---------------------------------------------------------------------------

describe('analyzeGlb', () => {
  it('counts primitives as draw calls and indices as triangles', () => {
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ count: 30 }],
      },
      null,
    )
    const a = analyzeGlb(glb)
    expect(a.drawCalls).toBe(1)
    expect(a.triangles).toBe(10)
    expect(a.textureMemoryBytes).toBe(0)
  })

  it('counts STRIP triangles as n-2', () => {
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }],
        accessors: [{ count: 10 }],
      },
      null,
    )
    expect(analyzeGlb(glb).triangles).toBe(8)
  })

  it('uses the indices accessor count when present', () => {
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [{ count: 1000 }, { count: 30 }],
      },
      null,
    )
    expect(analyzeGlb(glb).triangles).toBe(10)
  })

  it('counts PNG texture memory with 4/3 mipmap factor', () => {
    const png = fakePng(512, 512)
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ count: 3 }],
        bufferViews: [{ byteOffset: 0, byteLength: png.length }],
        images: [{ bufferView: 0, mimeType: 'image/png' }],
      },
      png,
    )
    const a = analyzeGlb(glb)
    expect(a.textures).toHaveLength(1)
    const tex = a.textures[0]
    if (!tex) throw new Error('expected one texture')
    expect(tex.width).toBe(512)
    expect(tex.height).toBe(512)
    expect(tex.compressed).toBe(false)
    expect(a.textureMemoryBytes).toBe(Math.ceil(512 * 512 * 4 * (4 / 3)))
  })

  it('treats KHR_texture_basisu sources as compressed (0.5 bpp)', () => {
    const png = fakePng(256, 256)
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [],
        bufferViews: [{ byteOffset: 0, byteLength: png.length }],
        images: [{ bufferView: 0, mimeType: 'image/png' }],
        textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      },
      png,
    )
    const a = analyzeGlb(glb)
    const tex = a.textures[0]
    if (!tex) throw new Error('expected one texture')
    expect(tex.compressed).toBe(true)
    expect(a.textureMemoryBytes).toBe(Math.ceil(256 * 256 * 0.5 * (4 / 3)))
  })

  it('warns on external URI images without counting them', () => {
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [],
        images: [{ uri: 'https://example.com/tex.png' }],
      },
      null,
    )
    const a = analyzeGlb(glb)
    expect(a.textures).toHaveLength(1)
    expect(a.textureMemoryBytes).toBe(0)
    expect(a.warnings.some((w) => w.includes('external URI'))).toBe(true)
  })

  it('warns on bad bufferView references', () => {
    const glb = buildGlb(
      {
        asset: { version: '2.0' },
        meshes: [],
        images: [{ bufferView: 999 }],
        bufferViews: [],
      },
      new Uint8Array(16),
    )
    const a = analyzeGlb(glb)
    expect(a.warnings.some((w) => w.includes('bufferView 999'))).toBe(true)
  })

  it('rejects too-short input', () => {
    expect(() => analyzeGlb(new Uint8Array(4))).toThrow(/too short/)
  })

  it('rejects bad magic', () => {
    expect(() => analyzeGlb(new Uint8Array(20))).toThrow(/magic/)
  })

  it('rejects wrong GLB version', () => {
    const buf = new Uint8Array(20)
    const dv = new DataView(buf.buffer)
    dv.setUint32(0, 0x46546c67, true)
    dv.setUint32(4, 1, true)
    dv.setUint32(8, 20, true)
    expect(() => analyzeGlb(buf)).toThrow(/version/)
  })
})

// ---------------------------------------------------------------------------
// checkRenderBudget
// ---------------------------------------------------------------------------

describe('checkRenderBudget', () => {
  it('passes when under every limit', () => {
    expect(checkRenderBudget(emptyAnalysis(), BUDGET, 'test')).toEqual([])
  })

  it('does not flag at exactly the limit', () => {
    const v = checkRenderBudget(
      emptyAnalysis({
        drawCalls: BUDGET.maxDrawCalls,
        triangles: BUDGET.maxTriangles,
        textureMemoryBytes: BUDGET.maxTextureMemoryMiB * 1024 * 1024,
      }),
      BUDGET,
      'test',
    )
    expect(v).toEqual([])
  })

  it('flags draw calls over budget', () => {
    const v = checkRenderBudget(
      emptyAnalysis({ drawCalls: BUDGET.maxDrawCalls + 1 }),
      BUDGET,
      'test',
    )
    expect(v.map((x) => x.id)).toContain('render.drawCalls')
  })

  it('flags triangles over budget', () => {
    const v = checkRenderBudget(
      emptyAnalysis({ triangles: BUDGET.maxTriangles + 1 }),
      BUDGET,
      'test',
    )
    expect(v.map((x) => x.id)).toContain('render.triangles')
  })

  it('flags texture memory over budget', () => {
    const v = checkRenderBudget(
      emptyAnalysis({
        textureMemoryBytes: (BUDGET.maxTextureMemoryMiB + 1) * 1024 * 1024,
      }),
      BUDGET,
      'test',
    )
    expect(v.map((x) => x.id)).toContain('render.textureMemory')
  })

  it('includes the subject and actual value in the message', () => {
    const v = checkRenderBudget(emptyAnalysis({ drawCalls: 999 }), BUDGET, 'court.glb')
    const first = v[0]
    if (!first) throw new Error('expected a violation')
    expect(first.message).toContain('court.glb')
    expect(first.message).toContain('999')
    expect(first.message).toContain('10')
  })
})

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('includes the label, viewport, and every metric row', () => {
    const md = renderMarkdown(emptyAnalysis(), BUDGET, [], 'test.glb')
    expect(md).toContain('test.glb')
    expect(md).toContain('390×844')
    expect(md).toContain('Draw calls')
    expect(md).toContain('Triangles')
    expect(md).toContain('Texture memory')
    expect(md).toContain('Frame time')
    expect(md).toContain('✅ Render budget met')
  })

  it('reports violations instead of the success line', () => {
    const analysis = emptyAnalysis({ drawCalls: 999 })
    const violations = checkRenderBudget(analysis, BUDGET, 'test.glb')
    const md = renderMarkdown(analysis, BUDGET, violations, 'test.glb')
    expect(md).toContain('❌ 1 render budget violation(s)')
    expect(md).toContain('999 draw calls > 10')
    expect(md).not.toContain('✅ Render budget met')
  })

  it('renders texture details when textures are present', () => {
    const analysis: GlbAnalysis = {
      drawCalls: 1,
      triangles: 2,
      textureMemoryBytes: 349526,
      textures: [{ name: 'floor', width: 256, height: 256, bytes: 349526, compressed: false }],
      warnings: [],
    }
    const md = renderMarkdown(analysis, BUDGET, [], 'test.glb')
    expect(md).toContain('floor')
    expect(md).toContain('256×256')
    expect(md).toContain('RGBA8')
  })

  it('renders analyzer warnings', () => {
    const analysis = emptyAnalysis({ warnings: ['image floor: unsupported format image/webp'] })
    const md = renderMarkdown(analysis, BUDGET, [], 'test.glb')
    expect(md).toContain('Warnings:')
    expect(md).toContain('unsupported format')
  })
})