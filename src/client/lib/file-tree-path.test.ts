import { describe, expect, it } from 'vitest'
import { isAncestorPath } from './file-tree-path'

describe('isAncestorPath', () => {
  it('returns true for direct parent folders', () => {
    expect(isAncestorPath('src', 'src/App.tsx')).toBe(true)
    expect(isAncestorPath('发票', '发票/26年3月/交通400.pdf')).toBe(true)
  })

  it('returns true for nested ancestor folders', () => {
    expect(isAncestorPath('发票/26年3月', '发票/26年3月/交通400.pdf')).toBe(true)
  })

  it('returns false for unrelated paths and files at the same level', () => {
    expect(isAncestorPath('src', 'README.md')).toBe(false)
    expect(isAncestorPath('src/App.tsx', 'src/App.tsx')).toBe(false)
  })

  it('treats workspace root as ancestor of nested paths only', () => {
    expect(isAncestorPath('', 'Desktop/截图.jpg')).toBe(true)
    expect(isAncestorPath('', 'README.md')).toBe(false)
  })
})
