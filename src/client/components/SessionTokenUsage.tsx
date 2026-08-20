import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { useChatStore, type ContextUsage } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import { getContextWindowForModel } from '../utils/model-context'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface SessionTokenUsageProps {
  sessionId: string
  workspaceId: string
  modelUsage?: Record<string, unknown>
}

/** Segment palette for the category bar (stable per index). */
const CATEGORY_COLORS = [
  '#6366f1', // indigo
  '#22c55e', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#14b8a6', // teal
  '#a855f7', // purple
  '#ef4444', // red
  '#3b82f6', // blue
] as const

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

interface SectionRow {
  key: string
  label: string
  primary: string
  secondary: string
  tokens: number
}

function ContextUsageCard({ usage }: { usage: ContextUsage }) {
  const { t } = useTranslation('chat')

  const visibleCategories = usage.categories.filter(
    (c) => c.tokens > 0 && !c.name.toLowerCase().includes('free'),
  )
  const segments = visibleCategories.map((category, index) => ({
    name: category.name,
    tokens: category.tokens,
    color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
  }))
  const totalForBar = Math.max(usage.maxTokens, usage.totalTokens, 1)

  const sections: { title: string; rows: SectionRow[] }[] = []
  if (usage.mcpTools && usage.mcpTools.length > 0) {
    sections.push({
      title: t('tokenUsage.mcpTools'),
      rows: usage.mcpTools
        .slice()
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .map((tool) => ({
          key: tool.name,
          label: tool.name,
          primary: tool.serverName,
          secondary: tool.serverName,
          tokens: tool.tokens,
        })),
    })
  }
  if (usage.memoryFiles && usage.memoryFiles.length > 0) {
    sections.push({
      title: t('tokenUsage.memoryFiles'),
      rows: usage.memoryFiles
        .slice()
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .map((file) => ({
          key: file.path,
          label: file.path.split('/').pop() || file.path,
          primary: file.type,
          secondary: file.type,
          tokens: file.tokens,
        })),
    })
  }
  if (usage.agents && usage.agents.length > 0) {
    sections.push({
      title: t('tokenUsage.agents'),
      rows: usage.agents
        .slice()
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .map((agent) => ({
          key: agent.agentType,
          label: agent.agentType,
          primary: agent.source,
          secondary: agent.source,
          tokens: agent.tokens,
        })),
    })
  }
  if (usage.skills && usage.skills.length > 0) {
    sections.push({
      title: t('tokenUsage.skills'),
      rows: usage.skills
        .slice()
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .map((skill) => ({
          key: skill.name,
          label: skill.name,
          primary: skill.source,
          secondary: skill.source,
          tokens: skill.tokens,
        })),
    })
  }

  return (
    <div className="w-72 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text-primary">
          {t('tokenUsage.contextCardTitle')}
        </span>
        {usage.model && (
          <span className="max-w-[140px] truncate text-[10px] text-text-tertiary" title={usage.model}>
            {usage.model}
          </span>
        )}
      </div>

      <div className="text-[11px] text-text-secondary">
        {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)} tokens · {usage.percentage}%
      </div>

      {usage.overLimit && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {t('tokenUsage.overLimit', {
            tokens: formatTokens(usage.overLimit.tokensOver),
          })}
        </div>
      )}

      {/* Segmented usage bar with optional autocompact threshold notch */}
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface-hover">
        <div className="flex h-full w-full">
          {segments.map((segment) => (
            <div
              key={segment.name}
              className="h-full"
              style={{
                width: `${Math.min(100, (segment.tokens / totalForBar) * 100)}%`,
                backgroundColor: segment.color,
              }}
              title={`${segment.name}: ${formatTokens(segment.tokens)}`}
            />
          ))}
        </div>
        {usage.autoCompactThreshold !== undefined &&
          usage.autoCompactThreshold > 0 &&
          usage.autoCompactThreshold < totalForBar && (
            <div
              className="absolute inset-y-0 w-px bg-text-primary/60"
              style={{
                left: `${Math.min(100, (usage.autoCompactThreshold / totalForBar) * 100)}%`,
              }}
              title={t('tokenUsage.autoCompactThreshold')}
            />
          )}
      </div>

      <div className="space-y-1">
        {segments.map((segment) => (
          <div key={segment.name} className="flex items-center gap-2 text-[11px]">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: segment.color }}
            />
            <span className="min-w-0 flex-1 truncate text-text-secondary">{segment.name}</span>
            <span className="shrink-0 tabular-nums text-text-tertiary">
              {formatTokens(segment.tokens)}
            </span>
          </div>
        ))}
      </div>

      {sections.map((section) => (
        <div key={section.title} className="space-y-1 border-t border-border/40 pt-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
            {section.title}
          </div>
          {section.rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-text-secondary" title={row.primary}>
                {row.label}
              </span>
              <span className="shrink-0 tabular-nums text-text-tertiary">
                {formatTokens(row.tokens)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export default function SessionTokenUsage({
  sessionId,
  workspaceId,
  modelUsage,
}: SessionTokenUsageProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const cumulative = useChatStore((s) => s.sessionUsage[sessionId])
  const contextUsage = useChatStore((s) => s.contextUsage[sessionId])
  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const providers = useProviderStore((s) => s.providers)
  const activeProvider = providers.find((p) => p.id === session?.providerId)
  const modelName =
    activeProvider?.model || activeProvider?.name || 'claude-sonnet-4-6'

  const contextWindow = getContextWindowForModel(modelName, modelUsage)
  const hasSessionData = !!cumulative
  const hasContextUsage = !!contextUsage

  const fillPercentage = hasContextUsage
    ? contextUsage.percentage
    : hasSessionData
      ? Math.min(
          Math.round((cumulative.cumulativeInput / contextWindow) * 100),
          100,
        )
      : undefined

  if (fillPercentage === undefined) {
    return (
      <span className="text-[11px] text-text-tertiary">—</span>
    )
  }

  // Without structured context data there is nothing to show in the card.
  if (!hasContextUsage) {
    return (
      <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
        {t('tokenUsage.context')}: {fillPercentage}%
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          title={t('tokenUsage.contextCardTitle')}
        >
          <Gauge className="size-3" />
          {t('tokenUsage.context')}: {fillPercentage}%
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="z-50 rounded-lg border border-border bg-surface-active p-3 shadow-lg"
      >
        <ContextUsageCard usage={contextUsage} />
      </PopoverContent>
    </Popover>
  )
}
