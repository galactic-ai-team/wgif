// apps/player/src/quality.test.ts
import { describe, expect, it } from 'vitest'
import { QualityGovernor } from './quality.js'

// Frame times: FAST is roughly 60fps, SLOW is roughly 40fps and above the
// SLOW_FRAME_MS=20 threshold. The settle and window constants mirror the
// module-level values in quality.ts. If those change, these tests are
// intended to break and be updated — the point is to test behavior, not
// the constants themselves.
const FAST = 16.67
const SLOW = 25
const SETTLE = 30
const WINDOW = 45

function feed(g: QualityGovernor, n: number, ms: number): number {
  let changes = 0
  for (let i = 0; i < n; i++) {
    if (g.sample(ms)) changes++
  }
  return changes
}

describe('QualityGovernor initial state', () => {
  it('starts at level 1 (1.5x) on mobile, level 0 (2x) on desktop', () => {
    const mobile = new QualityGovernor({ devicePixelRatio: 3, mobile: true })
    expect(mobile.level).toBe(1)
    expect(mobile.settings.pixelRatio).toBe(1.5)
    expect(mobile.settings.shadows).toBe(true)
    expect(mobile.ceiling).toBe(0)

    const desktop = new QualityGovernor({ devicePixelRatio: 2, mobile: false })
    expect(desktop.level).toBe(0)
    expect(desktop.settings.pixelRatio).toBe(2)
    expect(desktop.settings.shadows).toBe(true)
  })

  it('caps pixel ratio at the device DPR when DPR is below the level cap', () => {
    const g = new QualityGovernor({ devicePixelRatio: 1, mobile: false })
    // min(devicePixelRatio=1, level 0 maxPixelRatio=2) = 1
    expect(g.settings.pixelRatio).toBe(1)
  })
})

describe('QualityGovernor step-down', () => {
  it('does not drop after a single slow window', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })
    feed(g, SETTLE + WINDOW, SLOW)
    expect(g.level).toBe(0)
  })

  it('drops one level after two consecutive slow windows', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })
    const changes = feed(g, SETTLE + 2 * WINDOW, SLOW)
    expect(g.level).toBe(1)
    expect(changes).toBe(1)
  })

  it('cascades to the floor (level 4) and stays there', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })
    feed(g, SETTLE + 20 * WINDOW, SLOW)
    expect(g.level).toBe(4)
    expect(g.settings.pixelRatio).toBe(0.75)
    expect(g.settings.shadows).toBe(false)
    // Further slow frames cannot push past the last level.
    const extra = feed(g, SETTLE + 20 * WINDOW, SLOW)
    expect(extra).toBe(0)
    expect(g.level).toBe(4)
  })

  it('ignores frames over 250ms (tab switches, load hitches)', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })
    // 500 frames of 300ms each — none counted toward any window.
    feed(g, 500, 300)
    expect(g.level).toBe(0)
  })

  it('resets the slow-window counter on a fast window', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })
    // Settle + one slow window (slowWindows=1) + one fast window (reset) +
    // one slow window (slowWindows=1 again) — should NOT have dropped.
    feed(g, SETTLE + WINDOW, SLOW)
    feed(g, WINDOW, FAST)
    feed(g, WINDOW, SLOW)
    expect(g.level).toBe(0)
  })
})

describe('QualityGovernor probe and ceiling', () => {
  it('probes up after steady windows, fails on slow, and locks the ceiling', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })

    // Step down to level 1 (2 slow windows).
    feed(g, SETTLE + 2 * WINDOW, SLOW)
    expect(g.level).toBe(1)
    expect(g.ceiling).toBe(0)

    // Steady for 20+ windows triggers a probe back up to level 0.
    // 21*WINDOW gives 1 window of margin over the STEADY_WINDOWS_TO_PROBE=20 threshold.
    feed(g, SETTLE + 21 * WINDOW, FAST)
    expect(g.level).toBe(0)

    // Failed probe: one slow window while probing is enough to bounce back.
    feed(g, SETTLE + WINDOW, SLOW)
    expect(g.level).toBe(1)
    expect(g.ceiling).toBe(1)

    // Steady again, but at the ceiling: no further probe is attempted.
    const changed = feed(g, SETTLE + 21 * WINDOW, FAST)
    expect(g.level).toBe(1)
    expect(changed).toBe(0)
  })

  it('does not probe upward when already at the ceiling', () => {
    // Desktop starts at level 0 and ceiling 0, so level > ceiling is false.
    // Even with arbitrarily many fast windows, no probe fires.
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })
    const changes = feed(g, SETTLE + 100 * WINDOW, FAST)
    expect(g.level).toBe(0)
    expect(changes).toBe(0)
  })

  it('after a failed probe, a slow frame at the new ceiling drops again', () => {
    const g = new QualityGovernor({ devicePixelRatio: 3, mobile: false })

    // Reach level 1, probe up to 0, fail — back at level 1, ceiling 1.
    feed(g, SETTLE + 2 * WINDOW, SLOW)
    feed(g, SETTLE + 21 * WINDOW, FAST)
    feed(g, SETTLE + WINDOW, SLOW)
    expect(g.level).toBe(1)
    expect(g.ceiling).toBe(1)

    // Now a slow stretch at level 1 should still drop to level 2.
    feed(g, SETTLE + 2 * WINDOW, SLOW)
    expect(g.level).toBe(2)
    expect(g.ceiling).toBe(1)  // ceiling unchanged by drops
  })
})
