import { describe, it } from 'node:test'
import assert from 'node:assert'
import { computeTotalPendingCount } from './use-badge-sync'

describe('computeTotalPendingCount', () => {
  it('returns 0 for empty sessionStatus', () => {
    assert.strictEqual(computeTotalPendingCount({}), 0)
  })

  it('sums pending counts across sessions', () => {
    assert.strictEqual(
      computeTotalPendingCount({
        s1: { pendingCount: 2 },
        s2: { pendingCount: 3 },
      }),
      5,
    )
  })

  it('handles missing entries gracefully', () => {
    assert.strictEqual(
      computeTotalPendingCount({
        s1: { pendingCount: 1 },
        s2: undefined,
      }),
      1,
    )
  })

  it('returns 0 when all counts are zero', () => {
    assert.strictEqual(
      computeTotalPendingCount({
        s1: { pendingCount: 0 },
      }),
      0,
    )
  })
})
