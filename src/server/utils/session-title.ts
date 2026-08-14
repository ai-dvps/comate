import cliTruncate from 'cli-truncate';
import stripAnsi from 'strip-ansi';
import { redactSensitiveText } from './sensitive-text.js';

const TITLE_COLUMNS = 48;
const FALLBACK_TITLE = 'New chat';

function humanizeCommand(command: string): string {
  const words = command.replace(/^[/$]/, '').split(/[-_:./]+/).filter(Boolean).join(' ');
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : FALLBACK_TITLE;
}

function stripLogPrefix(line: string): string {
  return line
    .replace(/^\s*\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|\s*[+-]\d{2}:?\d{2})?\s*/, '')
    .replace(/^\s*(?:\[[A-Z][A-Z\d_-]*\]|(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\s*:?)\s*/i, '')
    .replace(/^\s*(?:[-*>]|\d+[.)])\s+/, '')
    .trim();
}

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/[`*_~]+/g, '')
    .trim();
}

function firstSentence(text: string): string {
  try {
    const Segmenter = (Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'sentence' },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }).Segmenter;
    if (!Segmenter) return text.split(/(?<=[。！？!?])\s*/u, 1)[0] || text;
    const segmenter = new Segmenter(undefined, { granularity: 'sentence' });
    const first = segmenter.segment(text)[Symbol.iterator]().next().value as
      | { segment?: string }
      | undefined;
    return first?.segment?.trim() || text;
  } catch {
    return text.split(/(?<=[。！？!?])\s*/u, 1)[0] || text;
  }
}

function codeIdentifier(lines: string[]): string | undefined {
  for (const line of lines) {
    const cleaned = stripLogPrefix(line);
    const error = /\b(?:[A-Za-z_$][\w$]*(?:Error|Exception)|ERROR)\b[^\n]*/.exec(cleaned);
    if (error) return error[0].trim();
    const declaration = /\b(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(cleaned);
    if (declaration?.[1]) return declaration[1];
  }
  return undefined;
}

function removeLeadingContextBlocks(text: string): string {
  return text.replace(/^\s*<([\w-]+-context)\b[^>]*>[\s\S]*?<\/\1>\s*/i, '');
}

function stripControlCharacters(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === '\n' || character === '\r' || character === '\t' || (code >= 32 && code !== 127);
    })
    .join('')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

export function deriveFallbackSessionTitle(prompt: string): string {
  // Redact before Markdown cleanup so token punctuation (for example the
  // underscore in a GitHub token) cannot be stripped before detection.
  let text = redactSensitiveText(
    stripControlCharacters(removeLeadingContextBlocks(stripAnsi(prompt))),
  ).trim();

  if (!text) return FALLBACK_TITLE;

  const command = /^[/$]([\w:@.-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (command) {
    if (!command[2]?.trim()) return humanizeCommand(command[1]);
    text = command[2].trim();
  }

  const prose: string[] = [];
  const code: string[] = [];
  let inFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    const line = rawLine.trim();
    if (!line) continue;
    const looksLikeCode = /^(?:import\b|export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\b|(?:async\s+)?(?:function|class|interface|type|enum)\b|(?:return|throw|if|for|while|switch|try|catch)\b|[{}])/u.test(line);
    if (inFence || looksLikeCode) code.push(line);
    else prose.push(line);
  }

  let candidate: string | undefined;
  for (const line of prose) {
    if (/^at\s+\S+/.test(line) || /^[-=_]{3,}$/.test(line)) continue;
    const cleaned = cleanMarkdownLine(stripLogPrefix(line));
    if (cleaned && !/^[{}[\](),;]+$/.test(cleaned)) {
      candidate = cleaned;
      break;
    }
  }

  candidate ??= codeIdentifier(code.length ? code : prose);
  candidate ??= code.length ? 'Code snippet' : FALLBACK_TITLE;

  candidate = firstSentence(candidate)
    .replace(/\s+/g, ' ')
    .replace(/[\s。！？!?；;：:]+$/u, '')
    .trim();
  candidate = redactSensitiveText(candidate);

  return cliTruncate(candidate || FALLBACK_TITLE, TITLE_COLUMNS, {
    position: 'end',
    preferTruncationOnSpace: true,
  });
}
