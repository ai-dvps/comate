import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'

interface SessionEffortBadgeProps {
  sessionId: string
}

/**
 * Effort chip from the CLI system/init frame (CLI 2.1.237+). Hidden when the
 * CLI does not report an effort level for the session's model.
 */
export default function SessionEffortBadge({ sessionId }: SessionEffortBadgeProps) {
  const { t } = useTranslation('chat')
  const effort = useChatStore((s) => s.sessionRuntimeInfo[sessionId]?.effort)

  if (effort === undefined || effort === null || effort === '') {
    return null
  }

  return (
    <span
      className="status-bar-effort shrink-0 whitespace-nowrap text-[11px] text-text-tertiary"
      title={t('tokenUsage.effortTitle')}
    >
      <span className="status-bar-label">{t('tokenUsage.effort')}: </span>{effort}
    </span>
  )
}
