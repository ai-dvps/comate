import { EditorView } from '@codemirror/view'

const baseStyles = {
  '&': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--color-text-primary))',
    fontSize: '13px',
    lineHeight: '1.5',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--color-accent))',
    padding: '8px 0',
  },
  '.cm-cursor': {
    borderLeftColor: 'hsl(var(--color-accent))',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'hsl(var(--color-accent) / 0.2)',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--color-accent) / 0.3)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--color-text-tertiary))',
    borderRight: '1px solid hsl(var(--color-border))',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'hsl(var(--color-surface-hover))',
  },
  '.cm-lineNumbers': {
    color: 'hsl(var(--color-text-tertiary))',
  },
  '.cm-line': {
    padding: '0 4px 0 8px',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--color-surface-hover))',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'hsl(var(--color-accent) / 0.15)',
    outline: '1px solid hsl(var(--color-accent) / 0.3)',
  },
  '.cm-nonmatchingBracket': {
    backgroundColor: 'hsl(var(--color-destructive) / 0.15)',
    outline: '1px solid hsl(var(--color-destructive) / 0.3)',
  },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--color-surface))',
    border: '1px solid hsl(var(--color-border))',
    color: 'hsl(var(--color-text-primary))',
  },
  '.cm-tooltip-autocomplete': {
    backgroundColor: 'hsl(var(--color-surface))',
    border: '1px solid hsl(var(--color-border))',
  },
  '.cm-completionLabel': {
    color: 'hsl(var(--color-text-primary))',
  },
  '.cm-completionMatchedText': {
    color: 'hsl(var(--color-accent))',
    textDecoration: 'none',
  },
  // Diff-specific styles
  '.cm-deletedChunk': {
    backgroundColor: 'hsl(var(--color-destructive) / 0.15)',
    borderLeft: '2px solid hsl(var(--color-destructive))',
  },
  '.cm-deletedLine': {
    backgroundColor: 'hsl(var(--color-destructive) / 0.1)',
    textDecoration: 'none',
  },
  '.cm-insertedLine': {
    backgroundColor: 'hsl(var(--color-success) / 0.15)',
  },
  '.cm-changedLine': {
    backgroundColor: 'hsl(var(--color-warning) / 0.1)',
  },
  '.cm-merge-gutter': {
    color: 'hsl(var(--color-text-tertiary))',
  },
  '.cm-merge-gutter .cm-deletedLineGutter': {
    color: 'hsl(var(--color-destructive))',
  },
  '.cm-merge-gutter .cm-insertedLineGutter': {
    color: 'hsl(var(--color-success))',
  },
}

export const comateLightTheme = EditorView.theme(baseStyles, { dark: false })
export const comateDarkTheme = EditorView.theme(baseStyles, { dark: true })

export function getComateThemeExtension(theme?: 'dark' | 'light') {
  const isDark =
    theme === 'dark' ||
    (theme === undefined &&
      (typeof document === 'undefined'
        ? false
        : document.documentElement.classList.contains('dark')))
  return isDark ? comateDarkTheme : comateLightTheme
}
