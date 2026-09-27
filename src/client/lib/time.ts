export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = seconds % 60
  return `${minutes}m ${remSeconds}s`
}
