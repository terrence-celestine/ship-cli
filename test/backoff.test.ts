import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { backoffDelayMs } from "../ship.js"

const MAX_BACKOFF_MS = 5 * 60_000

describe("backoffDelayMs", () => {
  test("a healthy poll waits exactly the configured interval", () => {
    assert.equal(backoffDelayMs(5_000, 0), 5_000)
    assert.equal(backoffDelayMs(600_000, 0), 600_000)
  })

  test("doubles per consecutive failure", () => {
    assert.equal(backoffDelayMs(5_000, 1), 10_000)
    assert.equal(backoffDelayMs(5_000, 2), 20_000)
    assert.equal(backoffDelayMs(5_000, 3), 40_000)
  })

  test("caps at 5 minutes for a short interval", () => {
    assert.equal(backoffDelayMs(5_000, 20), MAX_BACKOFF_MS)
  })

  // The non-obvious clamp: with a naive Math.min(x, 300_000) cap, failing would
  // make a --interval 600 run poll *more* often than a healthy one.
  test("the cap never drops below the configured interval", () => {
    const base = 600_000 // -i 600, longer than MAX_BACKOFF_MS
    for (const failures of [1, 2, 5, 20]) {
      assert.ok(
        backoffDelayMs(base, failures) >= base,
        `failing must never poll faster than healthy (failures=${failures})`,
      )
    }
  })

  test("delay is monotonically non-decreasing in failure count", () => {
    for (const base of [5_000, 60_000, 600_000]) {
      let previous = backoffDelayMs(base, 0)
      for (let f = 1; f <= 25; f++) {
        const current = backoffDelayMs(base, f)
        assert.ok(current >= previous, `base=${base} failures=${f}: ${current} < ${previous}`)
        previous = current
      }
    }
  })

  // ship.ts stops incrementing at MAX_TRACKED_FAILURES, but the clamp must hold
  // even if that guard were removed — 2 ** 1024 is Infinity.
  test("never returns Infinity or NaN, even at absurd failure counts", () => {
    for (const failures of [30, 100, 1024, 5000]) {
      const delay = backoffDelayMs(5_000, failures)
      assert.ok(Number.isFinite(delay), `failures=${failures} produced ${delay}`)
      assert.equal(delay, MAX_BACKOFF_MS)
    }
  })
})
