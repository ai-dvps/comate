import type { SlashCommandEvent } from '../../lib/cli-meta'
import { Message, MessageContent } from './message'

interface SlashCommandMessageProps {
  event: SlashCommandEvent
  messageId: string
}

export default function SlashCommandMessage({
  event,
  messageId,
}: SlashCommandMessageProps) {
  const commandName = `/${event.name.replace(/^\//, '')}`

  return (
    <Message from="user" key={messageId}>
      <MessageContent>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-md bg-accent/15 px-2 py-0.5 text-xs font-mono text-text-secondary">
            {commandName}
          </span>
          {event.args && (
            <span className="whitespace-pre-wrap text-sm text-text-primary">
              {event.args}
            </span>
          )}
        </div>
      </MessageContent>
    </Message>
  )
}
