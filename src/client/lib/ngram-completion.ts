const RUN_REGEX = /[A-Za-z0-9_]+|[一-鿿]+/g

type Script = 'latin' | 'cjk'

interface Token {
  text: string
  script: Script
}

function scriptOf(run: string): Script {
  return /^[A-Za-z0-9_]+$/.test(run) ? 'latin' : 'cjk'
}

function tokenizeRun(run: string): Token[] {
  const script = scriptOf(run)
  if (script === 'latin') return [{ text: run.toLowerCase(), script }]
  return Array.from(run).map((ch) => ({ text: ch, script }))
}

export function tokenize(text: string): string[] {
  return tokenizeWithScript(text).map((t) => t.text)
}

export function tokenizeWithScript(text: string): Token[] {
  const tokens: Token[] = []
  let match: RegExpExecArray | null
  RUN_REGEX.lastIndex = 0
  while ((match = RUN_REGEX.exec(text)) !== null) {
    tokens.push(...tokenizeRun(match[0]))
  }
  return tokens
}

export class TrigramCompletion {
  private trigrams = new Map<string, Map<string, number>>()
  private bigrams = new Map<string, Map<string, number>>()

  private increment(
    map: Map<string, Map<string, number>>,
    context: string,
    next: string,
  ) {
    let counts = map.get(context)
    if (!counts) {
      counts = new Map<string, number>()
      map.set(context, counts)
    }
    counts.set(next, (counts.get(next) ?? 0) + 1)
  }

  train(text: string) {
    const tokens = tokenizeWithScript(text)

    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i].script !== tokens[i + 1].script) continue
      this.increment(this.bigrams, tokens[i].text, tokens[i + 1].text)
    }

    for (let i = 0; i < tokens.length - 2; i++) {
      if (tokens[i + 1].script !== tokens[i + 2].script) continue
      this.increment(
        this.trigrams,
        `${tokens[i].text}|${tokens[i + 1].text}`,
        tokens[i + 2].text,
      )
    }
  }

  private suggestFromContext(
    context: string[],
    table: Map<string, Map<string, number>>,
  ): string | null {
    const key = context.join('|')
    const counts = table.get(key)
    if (!counts || counts.size === 0) return null

    let topToken: string | null = null
    let topCount = 0
    let secondCount = 0
    for (const [token, count] of counts) {
      if (count > topCount) {
        secondCount = topCount
        topCount = count
        topToken = token
      } else if (count > secondCount) {
        secondCount = count
      }
    }

    if (topToken && topCount >= 2 && topCount >= secondCount * 2) {
      return topToken
    }
    return null
  }

  suggest(text: string): string | null {
    const tokens = tokenizeWithScript(text)
    if (tokens.length === 0) return null

    const lastTwo = tokens.slice(-2).map((t) => t.text)
    const lastOne = tokens.slice(-1).map((t) => t.text)

    const candidate =
      (lastTwo.length === 2 &&
        this.suggestFromContext(lastTwo, this.trigrams)) ||
      this.suggestFromContext(lastOne, this.bigrams)

    if (!candidate) return null

    const endsWithSpace = /\s$/.test(text)
    const candidateIsLatin = /^[A-Za-z0-9_]+$/.test(candidate)

    if (candidateIsLatin && !endsWithSpace) {
      return ` ${candidate}`
    }
    return candidate
  }

  clear() {
    this.trigrams.clear()
    this.bigrams.clear()
  }
}
