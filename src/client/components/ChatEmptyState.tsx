import React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'

import { Button } from './ui/button'

interface ChatEmptyStateProps {
  onCreateSession: () => void
}

export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  onCreateSession,
}) => {
  const { t } = useTranslation('chat')

  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="flex flex-col items-center max-w-md text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-surface mb-4">
          <MessageSquare className="w-6 h-6 text-text-tertiary" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          {t('chatEmptyState.title')}
        </h2>
        <p className="text-sm text-text-secondary mb-6">
          {t('chatEmptyState.description')}
        </p>
        <Button onClick={onCreateSession}>
          {t('chatEmptyState.button')}
        </Button>
      </div>
    </div>
  )
}

ChatEmptyState.displayName = 'ChatEmptyState'

export default ChatEmptyState
