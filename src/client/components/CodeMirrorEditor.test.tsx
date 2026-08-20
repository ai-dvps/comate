import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import CodeMirrorEditor from './CodeMirrorEditor'

function getEditor(container: HTMLElement): HTMLElement {
  const editor = container.querySelector('.cm-editor')
  if (!(editor instanceof HTMLElement)) throw new Error('cm-editor not rendered')
  return editor
}

/**
 * Finds a stylesheet rule that targets the editor element itself (selector is
 * exactly one of its generated theme classes) and returns its height, if any.
 */
function getSelfRuleHeight(editor: HTMLElement): string | null {
  const ownClasses = Array.from(editor.classList)
  for (const sheet of Array.from(document.styleSheets)) {
    const rules = Array.from(sheet.cssRules ?? [])
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue
      if (!ownClasses.includes(rule.selectorText.slice(1))) continue
      if (rule.style.height) return rule.style.height
    }
  }
  return null
}

describe('CodeMirrorEditor', () => {
  it('applies a fill-height rule only when fillHeight is set', () => {
    const { container, unmount } = render(
      <CodeMirrorEditor value="abc" language={null} readOnly className="h-full" />,
    )
    expect(getSelfRuleHeight(getEditor(container))).toBeNull()
    unmount()

    const { container: filled } = render(
      <CodeMirrorEditor value="abc" language={null} readOnly className="h-full" fillHeight />,
    )
    expect(getSelfRuleHeight(getEditor(filled))).toBe('100%')
  })
})
