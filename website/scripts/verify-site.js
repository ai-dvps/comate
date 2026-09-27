import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const BASE = '/comate';
const PUBLIC_ORIGIN = 'https://ai-dvps.github.io';
const RELEASE_HOST = 'github.com';
const RELEASE_PATH_PREFIX = '/ai-dvps/comate/releases';
const DIST = resolve(import.meta.dirname, '../dist');
const SRC = resolve(import.meta.dirname, '../src');

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

function* walkSource(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walkSource(full);
    } else if (stats.isFile() && /\.(?:astro|ts|js)$/.test(entry) && !/\.test\./.test(entry)) {
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
  const cleanUrl = url.split(/[?#]/)[0];
  if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://') || cleanUrl.startsWith('//')) {
    return null;
  }

  if (cleanUrl.startsWith(BASE)) {
    return toFilesystemPath(cleanUrl);
  }

  if (cleanUrl.startsWith('/')) {
    return toFilesystemPath(cleanUrl);
  }

  if (cleanUrl.startsWith('.') || url.startsWith('?')) {
    const sourceDir = resolve(sourceFile, '..');
    const resolved = resolve(sourceDir, cleanUrl);
    return resolved.startsWith(DIST) ? resolved : null;
  }

  return null;
}

const errors = [];
const expectedCtaLocations = new Set([
  'nav_menu',
  'nav_primary',
  'mobile_nav_menu',
  'mobile_nav_primary',
  'footer_product',
  'home_hero',
  'home_closing',
  'features_header',
  'features_closing',
  'usage_closing',
  'download_primary',
  'download_secondary',
  'download_all_releases',
  'download_release_notes',
]);
const foundCtaLocations = new Set();
const canonicalOwners = new Map();

for (const required of requiredPaths) {
  const filePath = toFilesystemPath(required);
  if (!existsSync(filePath)) {
    errors.push(`Missing required page: ${required} (${relative(DIST, filePath)})`);
  }
}

for (const filePath of walk(DIST)) {
  const html = readFileSync(filePath, 'utf-8');
  const outputName = relative(DIST, filePath);
  const urls = extractUrls(html);
  for (const url of urls) {
    const resolved = resolveUrl(url, filePath);
    if (!resolved) continue;
    if (!existsSync(resolved)) {
      errors.push(`Broken link in ${relative(DIST, filePath)}: ${url}`);
    }
  }

  if (/^(?:zh|en)\//.test(outputName)) {
    const routePath = `/${outputName.replace(/index\.html$/, '')}`;
    const expectedPageUrl = `${PUBLIC_ORIGIN}${BASE}${routePath}`;
    const canonicalMatches = [...html.matchAll(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/gi)];
    const ogMatches = [...html.matchAll(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/gi)];
    if (canonicalMatches.length !== 1 || canonicalMatches[0]?.[1] !== expectedPageUrl) {
      errors.push(`Canonical URL is not exactly ${expectedPageUrl} in ${outputName}`);
    }
    if (ogMatches.length !== 1 || ogMatches[0]?.[1] !== expectedPageUrl) {
      errors.push(`Open Graph URL is not exactly ${expectedPageUrl} in ${outputName}`);
    }
    const priorOwner = canonicalOwners.get(expectedPageUrl);
    if (priorOwner) errors.push(`Duplicate canonical route ${expectedPageUrl}: ${priorOwner} and ${outputName}`);
    canonicalOwners.set(expectedPageUrl, outputName);
  }

  for (const [, location] of html.matchAll(/data-analytics-location="([a-z_]+)"/g)) {
    foundCtaLocations.add(location);
  }

  if (/^(?:zh|en)\//.test(outputName)) {
    if (!html.includes('id="analytics-consent"')) {
      errors.push(`Missing analytics consent controls in ${outputName}`);
    }
    if (!html.includes('data-analytics-choice="accept"') || !html.includes('data-analytics-choice="reject"')) {
      errors.push(`Consent choices are incomplete in ${outputName}`);
    }
    if (!html.includes('data-analytics-preferences')) {
      errors.push(`Missing persistent analytics preference control in ${outputName}`);
    }
    const disclosure = outputName.startsWith('zh/')
      ? '我们仅使用分析 Cookie 衡量匿名访问与下载操作'
      : 'we use analytics cookies only to measure anonymous visits and download actions';
    if (!html.includes(disclosure)) {
      errors.push(`Missing localized analytics privacy disclosure in ${outputName}`);
    }
  }

  if (/^(?:zh|en)\/download\/index\.html$/.test(outputName)) {
    const platformKeys = [...html.matchAll(/data-platform-download="(macos|windows|linux)"/g)].map((match) => match[1]);
    if (platformKeys.join(',') !== 'macos,windows,linux') {
      errors.push(`Download platforms must stay in stable macOS, Windows, Linux order in ${outputName}`);
    }
    for (const anchor of html.match(/<a\b[^>]*>/g) ?? []) {
      if (!anchor.includes('data-analytics-location="download_')) continue;
      if (!anchor.includes('data-analytics-event="release_download_click"')) {
        errors.push(`Release link lacks the primary analytics hook in ${outputName}: ${anchor}`);
      }
      if (!anchor.includes('data-analytics-stage="github_releases"')) {
        errors.push(`Release link lacks the destination-stage hook in ${outputName}: ${anchor}`);
      }
      const href = anchor.match(/href="([^"]+)"/)?.[1];
      try {
        const destination = new URL(href ?? '');
        if (destination.protocol !== 'https:' || destination.hostname !== RELEASE_HOST || !destination.pathname.startsWith(RELEASE_PATH_PREFIX)) {
          errors.push(`Release link uses an unapproved destination in ${outputName}: ${href}`);
        }
      } catch {
        errors.push(`Release link is not an absolute HTTPS URL in ${outputName}: ${href ?? '(missing)'}`);
      }
    }
    if (!html.includes('id="provider-prerequisite"') || !html.includes('#provider-setup')) {
      errors.push(`Provider prerequisite is not adjacent to download decisions in ${outputName}`);
    }
  }

  if (/^(?:zh|en)\/(?:download|about|faq)\/index\.html$/.test(outputName)) {
    const staleClaims = [
      /Claude Code/i,
      /Tauri/i,
      /macOS 13(?:\.0)?\+/i,
      /future (?:Linux|.*Linux.*demand)/i,
      /未来.*Linux/,
      /supports? (?:only )?macOS and Windows/i,
      /仅支持.*macOS.*Windows/,
    ];
    for (const claim of staleClaims) {
      if (claim.test(html)) errors.push(`Forbidden stale product claim ${claim} in ${outputName}`);
    }
  }

}

for (const location of expectedCtaLocations) {
  if (!foundCtaLocations.has(location)) errors.push(`Missing CTA analytics hook: ${location}`);
}

for (const filePath of walkSource(SRC)) {
  const source = readFileSync(filePath, 'utf-8');
  if (/G-[A-Z0-9]{6,}/.test(source)) {
    errors.push(`Hard-coded GA4 Measurement ID in ${relative(SRC, filePath)}`);
  }
}

if (errors.length) {
  console.error(`Site verification failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `Site verification passed. ${requiredPaths.length} required pages, internal links, consent privacy controls, and CTA hooks are valid.`,
);
