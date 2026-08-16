export const PROMPT_SKILL_HIGHLIGHT_NAME = 'prompt-skill-reference'
export const PROMPT_FILE_HIGHLIGHT_NAME = 'prompt-file-reference'

interface PromptReferenceHighlightRanges {
  skill: AbstractRange[]
  file: AbstractRange[]
}

const skillRangesByOwner = new Map<symbol, AbstractRange[]>()
const fileRangesByOwner = new Map<symbol, AbstractRange[]>()

function getRegistry(): HighlightRegistry | null {
  if (
    typeof CSS === 'undefined' ||
    typeof Highlight === 'undefined' ||
    !('highlights' in CSS)
  ) {
    return null
  }
  return CSS.highlights
}

function snapshotRange(range: AbstractRange): AbstractRange {
  if (typeof StaticRange === 'undefined' || typeof Range === 'undefined') {
    return range
  }
  if (!(range instanceof Range)) return range
  return new StaticRange({
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  })
}

function rebuildHighlight(
  registry: HighlightRegistry,
  name: string,
  rangesByOwner: Map<symbol, AbstractRange[]>,
): void {
  const ranges = Array.from(rangesByOwner.values()).flat()
  if (ranges.length === 0) {
    registry.delete(name)
    return
  }
  registry.set(name, new Highlight(...ranges))
}

function rebuildAll(registry: HighlightRegistry): void {
  rebuildHighlight(registry, PROMPT_SKILL_HIGHLIGHT_NAME, skillRangesByOwner)
  rebuildHighlight(registry, PROMPT_FILE_HIGHLIGHT_NAME, fileRangesByOwner)
}

export function setPromptReferenceHighlights(
  owner: symbol,
  ranges: PromptReferenceHighlightRanges,
): void {
  const registry = getRegistry()
  if (!registry) return

  skillRangesByOwner.set(owner, ranges.skill.map(snapshotRange))
  fileRangesByOwner.set(owner, ranges.file.map(snapshotRange))
  rebuildAll(registry)
}

export function clearPromptReferenceHighlights(owner: symbol): void {
  skillRangesByOwner.delete(owner)
  fileRangesByOwner.delete(owner)
  const registry = getRegistry()
  if (registry) rebuildAll(registry)
}
