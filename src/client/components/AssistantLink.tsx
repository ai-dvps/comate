import { memo, useCallback } from 'react'
import { cn } from './ui/utils'
import { openUrlInBrowser } from '../lib/open-url'

interface AnchorProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string
  children?: React.ReactNode
}

/**
 * Anchor override for Streamdown-rendered assistant messages.
 *
 * Preserves the existing link styling and plain-click behavior while adding
 * modifier-click (Ctrl/Cmd) to open the URL in the system default browser via
 * the Tauri `open_url` command.
 */
function AssistantLink({ href, children, className, ...props }: AnchorProps) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href || (!event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      event.stopPropagation()
      void openUrlInBrowser(href)
    },
    [href],
  )

  return (
    <a
      href={href}
      className={cn('wrap-anywhere font-medium text-primary underline', className)}
      target="_blank"
      rel="noreferrer"
      onClick={handleClick}
      {...props}
    >
      {children}
    </a>
  )
}

export default memo(AssistantLink)
