import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { ToolRendererProvider } from './ToolRendererContext'
import { useToolRendererContext } from './use-tool-renderer-context'

describe('ToolRendererContext', () => {
  it('returns default values when no provider is present', () => {
    const { result } = renderHook(() => useToolRendererContext())
    expect(result.current.workspacePath).toBeUndefined()
    expect(result.current.onOpenFile).toBeInstanceOf(Function)
    expect(() => result.current.onOpenFile('/foo', 'foo')).not.toThrow()
  })

  it('returns provided values inside a provider', () => {
    const onOpenFile = vi.fn()
    const { result } = renderHook(() => useToolRendererContext(), {
      wrapper: ({ children }) => (
        <ToolRendererProvider value={{ workspacePath: '/workspace', onOpenFile }}>
          {children}
        </ToolRendererProvider>
      ),
    })
    expect(result.current.workspacePath).toBe('/workspace')
    expect(result.current.onOpenFile).toBe(onOpenFile)
  })
})
