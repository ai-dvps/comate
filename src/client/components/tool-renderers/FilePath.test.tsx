import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import FilePath from './FilePath'
import { ToolRendererProvider } from './ToolRendererContext'

function renderWithContext(
  ui: ReactNode,
  { workspacePath, onOpenFile }: { workspacePath?: string; onOpenFile?: (path: string, name: string) => void } = {},
) {
  return render(
    <ToolRendererProvider
      value={{
        workspacePath,
        onOpenFile: onOpenFile ?? vi.fn(),
      }}
    >
      {ui}
    </ToolRendererProvider>,
  )
}

describe('FilePath', () => {
  it('renders relative path inside workspace and opens file on click', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/workspace/src/components/Button.tsx" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')

    await userEvent.click(pathEl)
    expect(onOpenFile).toHaveBeenCalledWith('src/components/Button.tsx', 'Button.tsx')
  })

  it('passes the relative path, not the absolute path, to onOpenFile', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/workspace/lib/utils.ts" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    await userEvent.click(screen.getByText('lib/utils.ts'))
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenFile.mock.calls[0][0]).toBe('lib/utils.ts')
    expect(onOpenFile.mock.calls[0][1]).toBe('utils.ts')
  })

  it('strips trailing slashes', () => {
    renderWithContext(<FilePath path="/workspace/src/" />, {
      workspacePath: '/workspace',
    })

    expect(screen.getByText('src')).toBeInTheDocument()
  })

  it('normalizes separators and ./ segments', () => {
    renderWithContext(<FilePath path="/workspace/./src/components\\\\Button.tsx" />, {
      workspacePath: '/workspace',
    })

    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
  })

  it('renders absolute text and is not clickable when path is outside workspace', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/etc/passwd" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    const pathEl = screen.getByText('/etc/passwd')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/etc/passwd')

    await userEvent.click(pathEl)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('renders directory paths non-clickable', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/workspace/src" isDirectory />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    const pathEl = screen.getByText('src')
    expect(pathEl.tagName.toLowerCase()).toBe('span')
    await userEvent.click(pathEl)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('renders workspace root non-clickable', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/workspace" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    const pathEl = screen.getByText('.')
    expect(pathEl.tagName.toLowerCase()).toBe('span')
    await userEvent.click(pathEl)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('renders path as-is when workspacePath is undefined', () => {
    renderWithContext(<FilePath path="/workspace/src/Button.tsx" />, {
      workspacePath: undefined,
    })

    expect(screen.getByText('/workspace/src/Button.tsx')).toBeInTheDocument()
  })
})
