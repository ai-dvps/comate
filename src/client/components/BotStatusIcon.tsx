import { CHANNEL_STATUS_CLASS, CHANNEL_STATUS_DOT, type ChannelStatus } from '../hooks/use-channel-statuses'

interface BotStatusIconProps {
  iconSrc: string
  alt: string
  status: ChannelStatus
  title: string
}

/**
 * Bot status icon + status-dot overlay. Shared by every bot indicator surface
 * (workspace tabs, workspace switcher). The wrapper span carries the accessible
 * name (bot + status) so screen readers announce the status rather than the
 * word "image"; the inner img is decorative.
 */
export function BotStatusIcon({ iconSrc, alt, status, title }: BotStatusIconProps) {
  return (
    <span
      className="relative inline-flex flex-shrink-0"
      title={title}
      role="img"
      aria-label={title}
    >
      <img
        src={iconSrc}
        alt={alt}
        aria-hidden="true"
        className={`w-3 h-3 flex-shrink-0 ${CHANNEL_STATUS_CLASS[status]}`}
      />
      <span
        className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${CHANNEL_STATUS_DOT[status]} ring-1 ring-bg`}
      />
    </span>
  )
}
