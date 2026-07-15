import { useTranslation } from 'react-i18next'
import { AlignLeft } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'
import { useAppSettings } from '../hooks/use-app-settings'

interface DisplayModeToggleProps {
  disabled?: boolean
}

/**
 * Header toggle for the chat display mode: result-focused (default) vs linear.
 * Reads/writes the global preference in `useAppSettings`; the message lists
 * reactively re-render on change (R4).
 */
export default function DisplayModeToggle({ disabled = false }: DisplayModeToggleProps) {
  const { t } = useTranslation('chat')
  const { displayMode, setDisplayMode } = useAppSettings()

  const isResultMode = displayMode !== 'linear'

  const handleToggle = () => {
    if (disabled) return
    setDisplayMode(isResultMode ? 'linear' : 'result')
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={isResultMode}
          aria-label={t('displayMode.title')}
          onClick={handleToggle}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            isResultMode
              ? 'bg-accent/10 border-accent/25 text-accent hover:bg-accent/20'
              : 'bg-transparent border-transparent text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
          }`}
        >
          <AlignLeft className="w-3 h-3" />
          <span className="hidden sm:inline">
            {isResultMode ? t('displayMode.result') : t('displayMode.linear')}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" sideOffset={6}>
        {t('displayMode.title')}
      </TooltipContent>
    </Tooltip>
  )
}
