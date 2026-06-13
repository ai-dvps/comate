/**
 * ToolUsageChart — ranked list of tools with progress bars.
 * Ported from the reference app; consumes comate's camelCase ToolUsageEntry.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'

import { cn } from '../ui/utils.js'
import { colorForIndex } from './analytics-utils.js'
import type { ToolUsageEntry } from '@server/services/analytics-aggregation.js'

interface ToolUsageChartProps {
  tools: ToolUsageEntry[]
}

const TOOL_LABELS: Record<string, string> = {
  Bash: 'tools.bash',
  Read: 'tools.read',
  Edit: 'tools.edit',
  Write: 'tools.write',
  MultiEdit: 'tools.multiEdit',
  Glob: 'tools.glob',
  Grep: 'tools.grep',
  LS: 'tools.ls',
  Task: 'tools.task',
  WebFetch: 'tools.webFetch',
  WebSearch: 'tools.webSearch',
  NotebookRead: 'tools.notebookRead',
  NotebookEdit: 'tools.notebookEdit',
  TodoRead: 'tools.todoRead',
  TodoWrite: 'tools.todoWrite',
  exit_plan_mode: 'tools.exitPlanMode',
}

export const ToolUsageChart: React.FC<ToolUsageChartProps> = ({ tools }) => {
  const { t } = useTranslation('analytics')
  const topTools = tools.slice(0, 6)
  const maxUsage = Math.max(...topTools.map((tool) => tool.count), 1)
  const totalUsage = topTools.reduce((sum, tool) => sum + tool.count, 0)

  if (topTools.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
        <Wrench className="w-10 h-10 opacity-20" />
        <p className="text-[10px] uppercase tracking-wider mt-3">{t('noToolData')}</p>
      </div>
    )
  }

  const resolveName = (toolName: string) => {
    const key = TOOL_LABELS[toolName]
    return key ? t(key) : toolName
  }

  return (
    <div className="space-y-2">
      {topTools.map((tool, index) => {
        const color = colorForIndex(index)
        const percentage = totalUsage === 0 ? 0 : (tool.count / totalUsage) * 100
        const barWidth = (tool.count / maxUsage) * 100

        return (
          <div
            key={tool.tool}
            className={cn(
              'flex items-center gap-3 p-2.5 rounded-md',
              'transition-colors duration-200',
              'hover:bg-surface-hover/30',
            )}
          >
            <div
              className="w-5 text-[10px] font-bold tabular-nums"
              style={{
                color: index < 3 ? color : 'hsl(var(--color-text-tertiary))',
              }}
            >
              {index + 1}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-medium text-text-primary/90 truncate pr-2">
                  {resolveName(tool.tool)}
                </span>
                <span
                  className="font-mono text-[11px] font-semibold tabular-nums shrink-0"
                  style={{ color }}
                >
                  {tool.count.toLocaleString()}
                </span>
              </div>

              <div className="h-1.5 bg-surface-hover/30 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barWidth}%`, backgroundColor: color, opacity: 0.8 }}
                />
              </div>
            </div>

            <div className="w-12 text-right shrink-0">
              <span className="font-mono text-[10px] text-text-tertiary tabular-nums">
                {percentage.toFixed(1)}%
              </span>
            </div>
          </div>
        )
      })}

      <div className="flex items-center justify-between pt-3 mt-2 border-t border-border/30">
        <span className="text-[9px] font-medium text-text-tertiary uppercase tracking-wider">
          {t('totalUsage')}
        </span>
        <span className="font-mono text-sm font-semibold text-text-primary tabular-nums">
          {totalUsage.toLocaleString()}
        </span>
      </div>
    </div>
  )
}

ToolUsageChart.displayName = 'ToolUsageChart'
