import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'

import { Button } from './ui/button'

interface ChatEmptyStateProps {
  onCreateSession: (name: string) => void
}

export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  onCreateSession,
}) => {
  const { t } = useTranslation('chat')
  const [name, setName] = useState('')

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onCreateSession(name.trim())
  }

  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="flex flex-col items-center max-w-sm w-full text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-surface mb-4">
          <MessageSquare className="w-6 h-6 text-text-tertiary" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          {t('chatEmptyState.title')}
        </h2>
        <p className="text-sm text-text-secondary mb-6">
          {t('chatEmptyState.description')}
        </p>
        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('chatEmptyState.placeholder')}
            className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <Button type="submit">
            {t('chatEmptyState.button')}
          </Button>
        </form>
      </div>
    </div>
  )
}

ChatEmptyState.displayName = 'ChatEmptyState'

export default ChatEmptyState
