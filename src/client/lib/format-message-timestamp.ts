/**
 * Format a message timestamp for display in the chat UI.
 *
 * - Same day as now: "HH:mm" (24-hour clock)
 * - Any other day: "YYYY-MM-DD HH:mm"
 *
 * All comparisons use the user's local timezone.
 */
export function formatMessageTimestamp(
  timestamp: number | undefined,
  now?: number,
): string {
  if (timestamp === undefined || Number.isNaN(timestamp)) {
    return ''
  }

  const date = new Date(timestamp)
  const nowDate = now === undefined ? new Date() : new Date(now)

  const isSameDay =
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate()

  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const time = `${hours}:${minutes}`

  if (isSameDay) {
    return time
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day} ${time}`
}
