// Lightweight frontmatter parser for slash command files.
// Supported fields: description, argument-hint, aliases (comma string or YAML list).
// Not supported: nested keys, multi-line strings (folded `>` / `|`), anchors.
// Falls back to plausible defaults when frontmatter is missing or unparsable.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SlashCommandDto } from '../types/initialization.js';

interface ParsedFrontmatter {
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};

  const body = match[1];
  const lines = body.split(/\r?\n/);
  const result: ParsedFrontmatter = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    const rawValue = kv[2];

    if (key === 'aliases' && rawValue.trim() === '') {
      // YAML list form
      const aliases: string[] = [];
      i += 1;
      while (i < lines.length) {
        const itemMatch = /^\s*-\s*(.+)$/.exec(lines[i]);
        if (!itemMatch) break;
        aliases.push(unquote(itemMatch[1]));
        i += 1;
      }
      if (aliases.length > 0) result.aliases = aliases;
      continue;
    }

    const value = unquote(rawValue);
    switch (key) {
      case 'description':
        if (value) result.description = value;
        break;
      case 'argument-hint':
      case 'argumentHint':
        if (value) result.argumentHint = value;
        break;
      case 'aliases': {
        const list = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (list.length > 0) result.aliases = list;
        break;
      }
      default:
        // Ignore unknown keys
        break;
    }
    i += 1;
  }

  return result;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function safeStat(filePath: string): Promise<{ isDirectory: boolean } | null> {
  try {
    const stats = await fs.stat(filePath);
    return { isDirectory: stats.isDirectory() };
  } catch {
    return null;
  }
}

function commandFromFile(name: string, content: string): SlashCommandDto {
  const fm = parseFrontmatter(content);
  return {
    name,
    description: fm.description ?? '',
    argumentHint: fm.argumentHint,
    aliases: fm.aliases,
  };
}

export async function parseCommandsDir(dir: string): Promise<SlashCommandDto[]> {
  const entries = await safeReadDir(dir);
  const results: SlashCommandDto[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(dir, entry);
    const content = await safeReadFile(filePath);
    if (content === null) continue;
    const name = entry.slice(0, -3);
    if (!name) continue;
    results.push(commandFromFile(name, content));
  }
  return results;
}

export async function parseSkillsDir(dir: string): Promise<SlashCommandDto[]> {
  const entries = await safeReadDir(dir);
  const results: SlashCommandDto[] = [];
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    const stat = await safeStat(skillDir);
    if (!stat?.isDirectory) continue;
    const skillFile = path.join(skillDir, 'SKILL.md');
    const content = await safeReadFile(skillFile);
    if (content === null) continue;
    results.push(commandFromFile(entry, content));
  }
  return results;
}

export async function parseCommandFile(
  filePath: string,
): Promise<SlashCommandDto | null> {
  const base = path.basename(filePath);
  if (base === 'SKILL.md') {
    const skillName = path.basename(path.dirname(filePath));
    if (!skillName) return null;
    const content = await safeReadFile(filePath);
    if (content === null) return null;
    return commandFromFile(skillName, content);
  }
  if (!base.endsWith('.md')) return null;
  const name = base.slice(0, -3);
  if (!name) return null;
  const content = await safeReadFile(filePath);
  if (content === null) return null;
  return commandFromFile(name, content);
}

export function commandNameFromFilePath(filePath: string): string | null {
  const base = path.basename(filePath);
  if (base === 'SKILL.md') {
    const dir = path.basename(path.dirname(filePath));
    return dir || null;
  }
  if (!base.endsWith('.md')) return null;
  const name = base.slice(0, -3);
  return name || null;
}
