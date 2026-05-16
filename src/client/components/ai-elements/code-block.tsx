/**
 * Adapted from Vercel AI Elements (Apache 2.0).
 * Original source: github.com/vercel/ai-elements (packages/elements/src/code-block.tsx)
 * Modifications:
 *  - Import `createHighlighter` from `shiki/bundle/web` (instead of `shiki`) so common
 *    languages are pre-bundled and the WASM tokenizer does not lazy-load at runtime.
 *  - Removed the `CodeBlockLanguageSelector*` family (it depends on a shadcn `Select`
 *    primitive that this repo does not vendor).
 *  - Token names remapped to this repo's Tailwind palette.
 */
'use client'

import { CheckIcon, CopyIcon } from 'lucide-react'
import type { ComponentProps, CSSProperties, HTMLAttributes } from 'react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from 'shiki'
import { createHighlighter } from 'shiki/bundle/web'

import { Button } from '../ui/button'
import { cn } from '../ui/utils'

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2
const isUnderline = (fontStyle: number | undefined) => fontStyle && fontStyle & 4

interface KeyedToken {
  token: ThemedToken
  key: string
}
interface KeyedLine {
  tokens: KeyedToken[]
  key: string
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }))

const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
    style={
      {
        backgroundColor: token.bgColor,
        color: token.color,
        fontStyle: isItalic(token.fontStyle) ? 'italic' : undefined,
        fontWeight: isBold(token.fontStyle) ? 'bold' : undefined,
        textDecoration: isUnderline(token.fontStyle) ? 'underline' : undefined,
        ...(typeof token.htmlStyle === 'object' && token.htmlStyle !== null
          ? token.htmlStyle
          : {}),
      } as CSSProperties
    }
  >
    {token.content}
  </span>
)

const LINE_NUMBER_CLASSES = cn(
  'block',
  "before:content-[counter(line)]",
  'before:inline-block',
  'before:[counter-increment:line]',
  'before:w-8',
  'before:mr-4',
  'before:text-right',
  'before:text-text-tertiary/50',
  'before:font-mono',
  'before:select-none',
)

const LineSpan = ({
  keyedLine,
  showLineNumbers,
}: {
  keyedLine: KeyedLine
  showLineNumbers: boolean
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : 'block'}>
    {keyedLine.tokens.length === 0
      ? '\n'
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} />
        ))}
  </span>
)

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}

interface TokenizedCode {
  tokens: ThemedToken[][]
  fg: string
  bg: string
}

interface CodeBlockContextType {
  code: string
}

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: '',
})

const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>()

const tokensCache = new Map<string, TokenizedCode>()

const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>()

const getTokensCacheKey = (code: string, language: BundledLanguage) => {
  const start = code.slice(0, 100)
  const end = code.length > 100 ? code.slice(-100) : ''
  return `${language}:${code.length}:${start}:${end}`
}

const getHighlighter = (
  language: BundledLanguage,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cached = highlighterCache.get(language)
  if (cached) {
    return cached
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: ['github-light', 'github-dark'],
  }) as Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>

  highlighterCache.set(language, highlighterPromise)
  return highlighterPromise
}

const createRawTokens = (code: string): TokenizedCode => ({
  bg: 'transparent',
  fg: 'inherit',
  tokens: code.split('\n').map((line) =>
    line === ''
      ? []
      : [
          {
            color: 'inherit',
            content: line,
          } as ThemedToken,
        ],
  ),
})

// eslint-disable-next-line react-refresh/only-export-components -- vendored helper alongside components
export const highlightCode = (
  code: string,
  language: BundledLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  const tokensCacheKey = getTokensCacheKey(code, language)

  const cached = tokensCache.get(tokensCacheKey)
  if (cached) {
    return cached
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set())
    }
    subscribers.get(tokensCacheKey)?.add(callback)
  }

  getHighlighter(language)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages()
      const langToUse = availableLangs.includes(language) ? language : 'text'

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          dark: 'github-dark',
          light: 'github-light',
        },
      })

      const tokenized: TokenizedCode = {
        bg: result.bg ?? 'transparent',
        fg: result.fg ?? 'inherit',
        tokens: result.tokens,
      }

      tokensCache.set(tokensCacheKey, tokenized)

      const subs = subscribers.get(tokensCacheKey)
      if (subs) {
        for (const sub of subs) {
          sub(tokenized)
        }
        subscribers.delete(tokensCacheKey)
      }
    })
    .catch((error) => {
      console.error('Failed to highlight code:', error)
      subscribers.delete(tokensCacheKey)
    })

  return null
}

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    className,
  }: {
    tokenized: TokenizedCode
    showLineNumbers: boolean
    className?: string
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    )

    const keyedLines = useMemo(
      () => addKeysToTokens(tokenized.tokens),
      [tokenized.tokens],
    )

    return (
      <pre
        className={cn(
          'dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 p-4 text-sm',
          className,
        )}
        style={preStyle}
      >
        <code
          className={cn(
            'font-mono text-sm',
            showLineNumbers && '[counter-increment:line_0] [counter-reset:line]',
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </code>
      </pre>
    )
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className,
)

CodeBlockBody.displayName = 'CodeBlockBody'

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      'group relative w-full overflow-hidden rounded-md border border-border bg-bg text-text-primary',
      className,
    )}
    data-language={language}
    style={{
      containIntrinsicSize: 'auto 200px',
      contentVisibility: 'auto',
      ...style,
    }}
    {...props}
  />
)

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex items-center justify-between border-b border-border bg-surface-hover/80 px-3 py-2 text-text-tertiary text-xs',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center gap-2', className)} {...props}>
    {children}
  </div>
)

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('font-mono', className)} {...props}>
    {children}
  </span>
)

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('-my-1 -mr-1 flex items-center gap-2', className)}
    {...props}
  >
    {children}
  </div>
)

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
}: {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}) => {
  const rawTokens = useMemo(() => createRawTokens(code), [code])

  const syncTokens = useMemo(
    () => highlightCode(code, language) ?? rawTokens,
    [code, language, rawTokens],
  )

  const [asyncTokens, setAsyncTokens] = useState<TokenizedCode | null>(null)
  const asyncKeyRef = useRef({ code, language })

  if (
    asyncKeyRef.current.code !== code ||
    asyncKeyRef.current.language !== language
  ) {
    asyncKeyRef.current = { code, language }
    setAsyncTokens(null)
  }

  useEffect(() => {
    let cancelled = false

    highlightCode(code, language, (result) => {
      if (!cancelled) {
        setAsyncTokens(result)
      }
    })

    return () => {
      cancelled = true
    }
  }, [code, language])

  const tokenized = asyncTokens ?? syncTokens

  return (
    <div className="relative overflow-auto">
      <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} />
    </div>
  )
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code])

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
        />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  )
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void
  onError?: (error: Error) => void
  timeout?: number
}

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)
  const { code } = useContext(CodeBlockContext)

  const copyToClipboard = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator?.clipboard?.writeText) {
      onError?.(new Error('Clipboard API not available'))
      return
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code)
        setIsCopied(true)
        onCopy?.()
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout,
        )
      }
    } catch (error) {
      onError?.(error as Error)
    }
  }, [code, onCopy, onError, timeout, isCopied])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    [],
  )

  const Icon = isCopied ? CheckIcon : CopyIcon

  return (
    <Button
      className={cn('shrink-0', className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  )
}
