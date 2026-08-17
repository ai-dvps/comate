import { describe, it, expect } from 'vitest'
import { backendAvailability, backendCapability, type BackendInfo } from './backend-store'

const backends: BackendInfo[] = [
  {
    id: 'claude',
    availability: { status: 'available' },
    capabilities: { imageInput: { state: 'full' } },
  },
  {
    id: 'opencode',
    availability: { status: 'unavailable', reason: 'binary missing' },
    capabilities: {
      analytics: { state: 'unavailable', reasonKey: 'backend.analyticsNotCounted' },
      imageInput: { state: 'full' },
    },
  },
]

describe('backendAvailability', () => {
  it('returns the matching backend availability', () => {
    expect(backendAvailability(backends, 'opencode')?.status).toBe('unavailable')
    expect(backendAvailability(backends, 'claude')?.status).toBe('available')
    expect(backendAvailability(backends, undefined)).toBeUndefined()
  })
})

describe('backendCapability', () => {
  it('returns declared entries', () => {
    expect(backendCapability(backends, 'opencode', 'analytics').state).toBe('unavailable')
    expect(backendCapability(backends, 'opencode', 'imageInput').state).toBe('full')
  })

  it('defaults undeclared to full on claude and unavailable elsewhere', () => {
    expect(backendCapability(backends, 'claude', 'hooks').state).toBe('full')
    expect(backendCapability(backends, 'opencode', 'hooks').state).toBe('unavailable')
    expect(backendCapability(backends, 'opencode', 'hooks').reasonKey).toBe('backend.capabilityUndeclared')
  })
})
