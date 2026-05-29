import { Streamdown } from 'streamdown'
import { cn } from './ui/utils'

interface MarkdownPreviewProps {
  content: string
  className?: string
}

export default function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  return (
    <Streamdown
      className={cn(
        'size-full px-6 py-4 text-text-primary',
        '[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:mb-4 [&_h1]:mt-6',
        '[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5',
        '[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4',
        '[&_h4]:text-base [&_h4]:font-semibold [&_h4]:mb-2 [&_h4]:mt-3',
        '[&_h5]:text-sm [&_h5]:font-semibold [&_h5]:mb-2 [&_h5]:mt-3',
        '[&_h6]:text-xs [&_h6]:font-semibold [&_h6]:mb-2 [&_h6]:mt-3',
        '[&_p]:mb-3 [&_p]:leading-relaxed',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-3',
        '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3',
        '[&_li]:mb-1',
        '[&_a]:text-accent [&_a]:underline hover:[&_a]:opacity-80',
        '[&_code]:bg-surface-hover [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono',
        '[&_pre]:bg-surface-hover [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mb-3 [&_pre]:overflow-auto',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-secondary [&_blockquote]:mb-3',
        '[&_hr]:border-border [&_hr]:my-4',
        '[&_img]:max-w-full [&_img]:rounded-lg',
        '[&_table]:w-full [&_table]:mb-3 [&_table]:border-collapse',
        '[&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:bg-surface-hover',
        '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
        className,
      )}
    >
      {content}
    </Streamdown>
  )
}
