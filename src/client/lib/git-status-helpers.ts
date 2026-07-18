import type { GitStatusItem } from '../stores/git-changes-store'

export function isUntrackedFile(item: GitStatusItem): boolean {
  return item.indexStatus === '?' && item.workingTreeStatus === '?'
}

export function getStatusBadgeClass(code: string): string {
  switch (code) {
    case 'M':
      return 'bg-warning/10 text-warning'
    case 'A':
      return 'bg-success/10 text-success'
    case 'D':
      return 'bg-destructive/10 text-destructive'
    case 'R':
      return 'bg-accent/10 text-accent'
    default:
      return 'bg-surface-hover text-text-secondary'
  }
}
