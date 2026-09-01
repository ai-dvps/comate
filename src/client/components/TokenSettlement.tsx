import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Coins } from 'lucide-react'
import type { TurnTokenUsage } from '../types/message'
import { formatTokenCount } from '../utils/token-format'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export default function TokenSettlement({ usage }: { usage: TurnTokenUsage }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  if (usage.quality === 'unavailable') {
    return (
      <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-text-tertiary"
        aria-label={`${t('tokenUsage.turn')}: ${t('tokenUsage.unavailable')}`}>
        <Coins className="size-3" aria-hidden="true" />
        {t('tokenUsage.turn')} · {t('tokenUsage.unavailable')}
      </div>
    )
  }

  const rows = [
    ['input', usage.inputTokens],
    ['output', usage.outputTokens],
    ['cacheRead', usage.cacheReadTokens],
    ['cacheWrite', usage.cacheWriteTokens],
    ['thinking', usage.thinkingTokens],
  ].filter((row): row is [string, number] => row[1] !== undefined)
  const prefix = usage.quality === 'estimated' ? `${t('tokenUsage.approx')} ` : ''
  const label = `${t('tokenUsage.turn')}: ${prefix}${formatTokenCount(usage.totalTokens)} tokens`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} title={label}
          className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
          <Coins className="size-3" aria-hidden="true" />
          <span>{t('tokenUsage.turn')} · {prefix}{formatTokenCount(usage.totalTokens)} tokens</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6}
        className="z-50 w-56 rounded-lg border border-border bg-surface-active p-3 shadow-lg">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-text-primary">
          <span>{t('tokenUsage.turn')}</span>
          <span className="tabular-nums">{prefix}{formatTokenCount(usage.totalTokens)}</span>
        </div>
        <div className="space-y-1">
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-4 text-[11px]">
              <span className="text-text-secondary">{t(`tokenUsage.${key}`)}</span>
              <span className="tabular-nums text-text-tertiary">{formatTokenCount(value)}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
