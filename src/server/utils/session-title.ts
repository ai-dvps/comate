import cliTruncate from 'cli-truncate';
import stripAnsi from 'strip-ansi';
import { redactSensitiveText } from './sensitive-text.js';

const TITLE_COLUMNS = 48;
const FALLBACK_TITLE = 'New chat';
const ALWAYS_INTERNAL_ABBREVIATIONS = new Set([
  'dr.', 'jr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.',
]);
const CONTEXTUAL_ABBREVIATIONS = new Set(['e.g.', 'etc.', 'i.e.']);
const CLOSING_SENTENCE_MARKS = new Set(['"', "'", ')', ']', '}', '’', '”']);

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
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!'。！？!?.'.includes(character)) continue;

    let closingEnd = index + 1;
    while (closingEnd < text.length && CLOSING_SENTENCE_MARKS.has(text[closingEnd])) closingEnd += 1;
    if (character !== '.') {
      return `${text.slice(0, index)}${text.slice(index + 1, closingEnd)}`.trim();
    }
    if (text[closingEnd] !== undefined && !/\s/u.test(text[closingEnd])) continue;

    let tokenStart = index;
    while (tokenStart > 0 && /[A-Za-z.]/u.test(text[tokenStart - 1])) tokenStart -= 1;
    const token = text.slice(tokenStart, index + 1).toLowerCase();
    if (ALWAYS_INTERNAL_ABBREVIATIONS.has(token) || /^(?:[a-z]\.){2,}$/u.test(token)) continue;
    if (CONTEXTUAL_ABBREVIATIONS.has(token)) {
      let nextStart = closingEnd;
      while (nextStart < text.length && /\s/u.test(text[nextStart])) nextStart += 1;
      if (nextStart === text.length || !/[A-Z]/u.test(text[nextStart])) continue;
    }
    let boundary = index;
    while (boundary > 0 && text[boundary - 1] === '.') boundary -= 1;
    return `${text.slice(0, boundary)}${text.slice(index + 1, closingEnd)}`.trim();
  }

  return text;
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
    .replace(/[\s.。！？!?；;：:]+$/u, '')
    .trim();
  candidate = redactSensitiveText(candidate);

  return cliTruncate(candidate || FALLBACK_TITLE, TITLE_COLUMNS, {
    position: 'end',
    preferTruncationOnSpace: true,
  });
}
