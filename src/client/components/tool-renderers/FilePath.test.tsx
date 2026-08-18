import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    Object.assign(navigator, { clipboard: originalClipboard })
  })

  it('renders relative path inside workspace', () => {
    renderWithContext(<FilePath path="/workspace/src/components/Button.tsx" />, {
      workspacePath: '/workspace',
    })

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')
  })

  it('opens file on plain click', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/workspace/src/components/Button.tsx" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    await userEvent.click(screen.getByText('src/components/Button.tsx'))
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

  it('copies relative path when copy button is clicked inside workspace without opening the file', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/workspace/src/components/Button.tsx" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    const copyButton = screen.getByRole('button', { name: 'Copy path' })
    await userEvent.click(copyButton)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'src/components/Button.tsx',
    )
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('falls back to absolute path when copy button is clicked outside workspace', async () => {
    renderWithContext(<FilePath path="/etc/passwd" />, {
      workspacePath: '/workspace',
    })

    const copyButton = screen.getByRole('button', { name: 'Copy path' })
    await userEvent.click(copyButton)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/etc/passwd')
  })

  it('copies workspace root as relative dot when copy button is clicked', async () => {
    renderWithContext(<FilePath path="/workspace" />, {
      workspacePath: '/workspace',
    })

    const copyButton = screen.getByRole('button', { name: 'Copy path' })
    await userEvent.click(copyButton)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('.')
  })

  it('truncates long relative paths from the start', () => {
    renderWithContext(
      <FilePath path="/workspace/src/components/Button.tsx" maxDisplayLength={10} />,
      {
        workspacePath: '/workspace',
      },
    )

    const pathEl = screen.getByText(/^…/)
    expect(pathEl.textContent).toMatch(/^…utton\.tsx$/)
    expect(pathEl).toHaveAttribute('title', '/workspace/src/components/Button.tsx')
  })

  it('shows an at-rest clickable affordance without hover or modifier state', () => {
    renderWithContext(<FilePath path="/workspace/src/components/Button.tsx" />, {
      workspacePath: '/workspace',
    })

    const pathEl = screen.getByText('src/components/Button.tsx')
    expect(pathEl).toHaveClass('cursor-pointer')
    expect(pathEl).toHaveClass('underline')
    expect(pathEl).toHaveClass('underline-offset-2')
    expect(pathEl).not.toHaveClass('cursor-default')
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

  it('renders absolute text without the clickable affordance and does not open when path is outside workspace', async () => {
    const onOpenFile = vi.fn()
    renderWithContext(<FilePath path="/etc/passwd" />, {
      workspacePath: '/workspace',
      onOpenFile,
    })

    const pathEl = screen.getByText('/etc/passwd')
    expect(pathEl).toBeInTheDocument()
    expect(pathEl).toHaveAttribute('title', '/etc/passwd')
    expect(pathEl.tagName.toLowerCase()).toBe('span')
    expect(pathEl).toHaveClass('cursor-default')
    expect(pathEl).not.toHaveClass('cursor-pointer')
    expect(pathEl).not.toHaveClass('underline')

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
