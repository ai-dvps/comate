import type {
  PromptReferenceKind,
  ValidatedPromptReference,
} from './prompt-references'

export type PromptReferenceCommitSource =
  | 'picker'
  | 'manual'
  | 'paste'
  | 'restore'

export interface CommittedPromptReference {
  id: string
  kind: PromptReferenceKind
  value: string
  text: string
  start: number
  end: number
  status: 'valid' | 'invalid'
  source: PromptReferenceCommitSource
}

interface CommitValidatedReferencesOptions {
  source: PromptReferenceCommitSource
  commitAtEnd?: boolean
}

function isManualCandidateComplete(
  input: string,
  candidate: ValidatedPromptReference,
  commitAtEnd: boolean,
): boolean {
  if (candidate.end < input.length) return /\s/.test(input[candidate.end])
  return commitAtEnd
}

function referenceKey(reference: {
  kind: PromptReferenceKind
  start: number
  end: number
}): string {
  return `${reference.kind}:${reference.start}:${reference.end}`
}

export function commitValidatedReferences(
  input: string,
  current: CommittedPromptReference[],
  candidates: ValidatedPromptReference[],
  options: CommitValidatedReferencesOptions,
): CommittedPromptReference[] {
  const existingKeys = new Set(current.map(referenceKey))
  const additions: CommittedPromptReference[] = []

  for (const candidate of candidates) {
    if (candidate.status !== 'valid') continue
    if (
      options.source === 'manual' &&
      !isManualCandidateComplete(
        input,
        candidate,
        options.commitAtEnd ?? false,
      )
    ) {
      continue
    }
    const key = referenceKey(candidate)
    if (existingKeys.has(key)) continue
    const text = input.slice(candidate.start, candidate.end)
    if (!text) continue
    additions.push({
      id: `${options.source}:${key}:${text}`,
      kind: candidate.kind,
      value: candidate.value,
      text,
      start: candidate.start,
      end: candidate.end,
      status: 'valid',
      source: options.source,
    })
    existingKeys.add(key)
  }

  return [...current, ...additions].sort((a, b) => a.start - b.start)
}

export function restoreCommittedReferences(
  input: string,
  candidates: ValidatedPromptReference[],
): CommittedPromptReference[] {
  return commitValidatedReferences(input, [], candidates, { source: 'restore' })
}

export function reconcileCommittedReferenceStatuses(
  current: CommittedPromptReference[],
  candidates: ValidatedPromptReference[],
): CommittedPromptReference[] {
  const statuses = new Map(
    candidates.map((candidate) => [referenceKey(candidate), candidate.status]),
  )
  return current.map((reference) => {
    const status = statuses.get(referenceKey(reference))
    if (status === undefined || status === 'pending') return reference
    return reference.status === status ? reference : { ...reference, status }
  })
}

export function rebaseCommittedReferences(
  previousInput: string,
  nextInput: string,
  current: CommittedPromptReference[],
): CommittedPromptReference[] {
  if (previousInput === nextInput) return current

  let editStart = 0
  while (
    editStart < previousInput.length &&
    editStart < nextInput.length &&
    previousInput[editStart] === nextInput[editStart]
  ) {
    editStart += 1
  }

  let sharedSuffix = 0
  while (
    sharedSuffix < previousInput.length - editStart &&
    sharedSuffix < nextInput.length - editStart &&
    previousInput[previousInput.length - 1 - sharedSuffix] ===
      nextInput[nextInput.length - 1 - sharedSuffix]
  ) {
    sharedSuffix += 1
  }

  const previousEditEnd = previousInput.length - sharedSuffix
  const nextEditEnd = nextInput.length - sharedSuffix
  const delta = nextEditEnd - previousEditEnd

  return current.flatMap((reference) => {
    if (reference.end <= editStart) return [reference]
    if (reference.start >= previousEditEnd) {
      return [
        {
          ...reference,
          start: reference.start + delta,
          end: reference.end + delta,
        },
      ]
    }
    return []
  })
}

export function cloneCommittedReferences(
  references: CommittedPromptReference[],
): CommittedPromptReference[] {
  return references.map((reference) => ({ ...reference }))
}

export function sameCommittedReferences(
  left: CommittedPromptReference[],
  right: CommittedPromptReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const other = right[index]
      return (
        reference.id === other.id &&
        reference.kind === other.kind &&
        reference.value === other.value &&
        reference.text === other.text &&
        reference.start === other.start &&
        reference.end === other.end &&
        reference.status === other.status &&
        reference.source === other.source
      )
    })
  )
}
