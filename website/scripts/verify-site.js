import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const BASE = '/comate';
const DIST = resolve(import.meta.dirname, '../dist');

const requiredPaths = [
  '/comate/',
  '/comate/zh/',
  '/comate/en/',
  '/comate/zh/features/',
  '/comate/en/features/',
  '/comate/zh/usage/',
  '/comate/en/usage/',
  '/comate/zh/download/',
  '/comate/en/download/',
  '/comate/zh/about/',
  '/comate/en/about/',
  '/comate/zh/faq/',
  '/comate/en/faq/',
];

function toFilesystemPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const stripped = decoded.startsWith(BASE) ? decoded.slice(BASE.length) : decoded;
  const normalized = stripped.endsWith('/') ? join(stripped, 'index.html') : stripped;
  return join(DIST, normalized);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (stats.isFile() && extname(entry) === '.html') {
      yield full;
    }
  }
}

function extractUrls(html) {
  const urls = [];
  const push = (raw) => {
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('data:')) return;
    urls.push(raw);
  };

  for (const [, attr] of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
    push(attr);
  }

  for (const [, srcset] of html.matchAll(/srcset=["']([^"']+)["']/gi)) {
    for (const part of srcset.split(',')) {
      const url = part.trim().split(/\s+/)[0];
      push(url);
    }
  }

  return urls;
}

function resolveUrl(url, sourceFile) {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) {
    return null;
  }

  if (url.startsWith(BASE)) {
    return toFilesystemPath(url);
  }

  if (url.startsWith('/')) {
    return toFilesystemPath(url);
  }

  if (url.startsWith('.') || url.startsWith('?')) {
    const sourceDir = resolve(sourceFile, '..');
    const resolved = resolve(sourceDir, url.split('?')[0]);
    return resolved.startsWith(DIST) ? resolved : null;
  }

  return null;
}

const errors = [];

for (const required of requiredPaths) {
  const filePath = toFilesystemPath(required);
  if (!existsSync(filePath)) {
    errors.push(`Missing required page: ${required} (${relative(DIST, filePath)})`);
  }
}

for (const filePath of walk(DIST)) {
  const html = readFileSync(filePath, 'utf-8');
  const urls = extractUrls(html);
  for (const url of urls) {
    const resolved = resolveUrl(url, filePath);
    if (!resolved) continue;
    if (!existsSync(resolved)) {
      errors.push(`Broken link in ${relative(DIST, filePath)}: ${url}`);
    }
  }
}

if (errors.length) {
  console.error(`Site verification failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`Site verification passed. ${requiredPaths.length} required pages and all internal links are reachable.`);
