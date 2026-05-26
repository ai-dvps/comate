import type { ChatMessage } from '../types/message'

export type CliMetaEvent =
  | { kind: 'slash-command'; name: string; message: string; args: string }
  | { kind: 'local-stdout'; body: string }
  | { kind: 'local-stderr'; body: string }
  | { kind: 'system-reminder'; body: string }

export type SlashCommandEvent = Extract<CliMetaEvent, { kind: 'slash-command' }>
export type LocalStdoutEvent = Extract<CliMetaEvent, { kind: 'local-stdout' }>
export type LocalStderrEvent = Extract<CliMetaEvent, { kind: 'local-stderr' }>
export type SystemReminderEvent = Extract<CliMetaEvent, { kind: 'system-reminder' }>

// Newer format: message → name → args
const SLASH_TRIPLET_RE_V2 =
  /^<command-message>([\s\S]*?)<\/command-message>\s*<command-name>([\s\S]*?)<\/command-name>\s*<command-args>([\s\S]*?)<\/command-args>$/
// Older format: name → message → args
const SLASH_TRIPLET_RE_V1 =
  /^<command-name>([\s\S]*?)<\/command-name>\s*<command-message>([\s\S]*?)<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>$/
const LOCAL_STDOUT_RE = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/
const LOCAL_STDERR_RE = /^<local-command-stderr>([\s\S]*)<\/local-command-stderr>$/
const SYSTEM_REMINDER_RE = /^<system-reminder>([\s\S]*)<\/system-reminder>$/

export function detectCliMeta(text: string): CliMetaEvent | null {
  const trimmed = text.trim()

  // Try newer format first (message → name → args)
  const slashV2 = SLASH_TRIPLET_RE_V2.exec(trimmed)
  if (slashV2) {
    const rawMessage = slashV2[1].trim()
    const name = slashV2[2].trim()
    const args = slashV2[3].trim()
    const message = rawMessage === name.replace(/^\//, '') ? '' : rawMessage
    return { kind: 'slash-command', name, message, args }
  }

  // Fall back to older format (name → message → args)
  const slashV1 = SLASH_TRIPLET_RE_V1.exec(trimmed)
  if (slashV1) {
    const name = slashV1[1].trim()
    const rawMessage = slashV1[2].trim()
    const args = slashV1[3].trim()
    const message = rawMessage === name.replace(/^\//, '') ? '' : rawMessage
    return { kind: 'slash-command', name, message, args }
  }

  const stdout = LOCAL_STDOUT_RE.exec(trimmed)
  if (stdout) {
    return { kind: 'local-stdout', body: stdout[1] }
  }

  const stderr = LOCAL_STDERR_RE.exec(trimmed)
  if (stderr) {
    return { kind: 'local-stderr', body: stderr[1] }
  }

  const reminder = SYSTEM_REMINDER_RE.exec(trimmed)
  if (reminder) {
    return { kind: 'system-reminder', body: reminder[1] }
  }

  return null
}

export function isWrapperShape(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<') && trimmed.endsWith('>')
}

export type ViewItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'meta'; event: CliMetaEvent; messageId: string }
  | {
      kind: 'meta-paired'
      slash: SlashCommandEvent
      output: LocalStdoutEvent | LocalStderrEvent
      messageIds: [string, string]
    }

const MAX_PAIRED_OUTPUT_CHARS = 80

function canonicalUserText(message: ChatMessage): string | null {
  if (message.role !== 'user') return null
  if (message.parts.length === 0) return null
  if (!message.parts.every((p) => p?.type === 'text')) return null
  return message.parts
    .map((p) => (p?.type === 'text' ? p.text : ''))
    .join('')
}

function isPairableOutput(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > MAX_PAIRED_OUTPUT_CHARS) return false
  if (trimmed.includes('\n')) return false
  return true
}

export function pairCliMeta(messages: ChatMessage[]): ViewItem[] {
  const intermediate: ViewItem[] = []

  for (const message of messages) {
    const text = canonicalUserText(message)
    if (text === null) {
      intermediate.push({ kind: 'message', message })
      continue
    }

    const event = detectCliMeta(text)
    if (!event) {
      intermediate.push({ kind: 'message', message })
      continue
    }

    if (
      (event.kind === 'local-stdout' || event.kind === 'local-stderr') &&
      event.body.trim() === ''
    ) {
      continue
    }

    intermediate.push({ kind: 'meta', event, messageId: message.id })
  }

  const result: ViewItem[] = []
  for (let i = 0; i < intermediate.length; i++) {
    const current = intermediate[i]
    const next = intermediate[i + 1]

    if (
      current.kind === 'meta' &&
      current.event.kind === 'slash-command' &&
      next &&
      next.kind === 'meta' &&
      (next.event.kind === 'local-stdout' || next.event.kind === 'local-stderr') &&
      isPairableOutput(next.event.body)
    ) {
      result.push({
        kind: 'meta-paired',
        slash: current.event,
        output: next.event,
        messageIds: [current.messageId, next.messageId],
      })
      i++
      continue
    }

    result.push(current)
  }

  return result
}
