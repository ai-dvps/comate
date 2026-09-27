import { cn } from '../ui/utils'
import { Response } from './response'
import AssistantLink from '../AssistantLink'

interface CompactableTextProps {
  children: string
  hasSearchMatch?: boolean
  isCurrentSearchMatch?: boolean
}

export default function CompactableText({
  children,
  hasSearchMatch = false,
  isCurrentSearchMatch = false,
}: CompactableTextProps) {
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg',
        hasSearchMatch && 'ring-1 bg-accent/5',
        hasSearchMatch && (isCurrentSearchMatch ? 'ring-accent' : 'ring-accent/30'),
      )}
    >
      <Response components={{ a: AssistantLink }}>{children}</Response>
    </div>
  )
}
