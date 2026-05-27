export default function CompactBoundary() {
  return (
    <div className="my-4 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-text-tertiary font-medium uppercase tracking-wide">
        Conversation compacted
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
