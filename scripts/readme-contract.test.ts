import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  canonicalVocabulary,
  platformFacts,
  providerPrerequisite,
  releaseDestination,
} from '../website/src/lib/site-facts.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positionOf(pattern: RegExp, message: string): number {
  const match = pattern.exec(readme);
  assert.ok(match, message);
  return match.index;
}

test('the README presents the canonical product story before installation', () => {
  const productCategory = canonicalVocabulary.find(({ key }) => key === 'product-category');
  assert.ok(productCategory, 'site facts must define the canonical product category');
  const productCategoryIndex = positionOf(
    new RegExp(escapeRegExp(productCategory.label.en), 'i'),
    'README must describe Comate as a general-purpose Agent task workspace',
  );

  const installationIndex = positionOf(
    /^##\s+(?:Installation|Install|Download|Get Comate)\b/im,
    'README must contain an installation or download section',
  );
  assert.ok(
    productCategoryIndex < installationIndex,
    'README must establish the product category before installation',
  );
  const productStory = readme.slice(0, installationIndex);
  assert.match(productStory, /\bfinance\b/i, 'README must establish the finance scenario before installation');
  assert.match(productStory, /\brequest\b/i, 'README finance story must begin with a concrete request');
  assert.match(productStory, /\breport\b/i, 'README finance story must reach a finished report');
});

test('the README states current Agent and Provider boundaries', () => {
  for (const agent of ['Claude Code', 'OpenCode', 'Codex']) {
    assert.match(readme, new RegExp(`\\b${agent.replace(' ', '\\s+')}\\b`, 'i'), `README must name ${agent}`);
  }
  assert.match(
    readme,
    /(?:experimental[^.\n]*Codex|Codex[^.\n]*experimental)/i,
    'README must identify the Codex backend as experimental',
  );

  assert.equal(
    providerPrerequisite.agentExecutionRequiresConfiguredProvider,
    true,
    'site facts must retain the Provider prerequisite used by this contract',
  );
  assert.equal(
    providerPrerequisite.freeInferenceIncluded,
    false,
    'site facts must retain the free-inference boundary used by this contract',
  );
  assert.match(
    readme,
    /(?:Agent|run(?:ning)?|execut(?:e|ion))[^.\n]*(?:Provider|model credentials|supported account|Agent account|sign[ -]?in)|(?:Provider|model credentials|supported account|Agent account|sign[ -]?in)[^.\n]*(?:Agent|run(?:ning)?|execut(?:e|ion))/i,
    'README must explain that Agent execution needs a Provider, model credentials, or supported Agent account',
  );
  assert.match(
    readme,
    /(?:does not|doesn't|no)\s+(?:include|provide|come with|bundled?)?\s*(?:a\s+)?free\s+(?:model\s+)?inference/i,
    'README must say that Comate does not include free inference',
  );
});

test('the README lists current platform artifacts and release destinations', () => {
  for (const platform of platformFacts) {
    assert.match(readme, new RegExp(`\\b${platform.label.en}\\b`, 'i'), `README must list ${platform.label.en}`);
  }
  const artifactKinds = platformFacts.flatMap(({ artifactKinds }) => artifactKinds);
  for (const artifact of artifactKinds) {
    const platformAlias = artifact === 'nsis' ? '(?:NSIS|\\.exe)' : `\\.?${artifact}`;
    assert.match(readme, new RegExp(`${platformAlias}\\b`, 'i'), `README must list the ${artifact} release artifact`);
  }

  assert.match(
    readme,
    new RegExp(escapeRegExp(releaseDestination.url)),
    'README must link to the official GitHub Releases page',
  );
  assert.match(
    readme,
    /https:\/\/gitee\.com\/ai-dvps\/comate\/releases\b/,
    'README must retain the Gitee release mirror',
  );
});

test('the README guides first use through New Chat', () => {
  const quickStartIndex = positionOf(
    /^##\s+(?:Quick Start|First Chat|Start Your First Chat|Your First Chat)\b/im,
    'README must contain concise first-chat guidance',
  );
  const nextSectionOffset = readme.slice(quickStartIndex + 1).search(/^##\s+/m);
  const quickStartEnd = nextSectionOffset === -1 ? readme.length : quickStartIndex + 1 + nextSectionOffset;
  const firstUse = readme.slice(quickStartIndex, quickStartEnd);

  assert.match(firstUse, /\bNew Chat\b/i, 'README quick start must begin from New Chat');

  assert.match(firstUse, /\bWorkspace\b/i, 'New Chat guidance must cover choosing or creating a Workspace');
  assert.match(firstUse, /\bAgent\b/i, 'New Chat guidance must cover choosing an Agent');
  assert.match(firstUse, /\bProvider\b/i, 'New Chat guidance must cover choosing a Provider when needed');
  assert.match(firstUse, /\b(?:prompt|request|message|send)\b/i, 'New Chat guidance must reach the first prompt');
});

test('the README uses valid local links and descriptive repository-owned product evidence', () => {
  const markdownLink = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  const images: Array<{ alt: string; target: string }> = [];

  for (const match of readme.matchAll(markdownLink)) {
    const [, imageMarker, label, rawTarget] = match;
    const target = rawTarget.split('#', 1)[0];
    if (imageMarker) images.push({ alt: label.trim(), target });
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;

    assert.ok(
      existsSync(resolve(repositoryRoot, decodeURIComponent(target))),
      `README local link target must exist: ${rawTarget}`,
    );
  }

  const productImage = images.find(({ target }) =>
    /^website\/public\/images\/product\/finance-(?:report|report-detail)\.webp(?:[#?].*)?$/.test(target),
  );
  assert.ok(productImage, 'README must reuse the repository-owned finance report product image');
  assert.ok(
    productImage.alt.length >= 24 && !/^(?:image|screenshot|product image)$/i.test(productImage.alt),
    'README product evidence must have descriptive alt text',
  );
  assert.match(
    readme,
    /\[[^\]]*(?:develop|contribut|setup)[^\]]*\]\((?:\.\/)?development\.md\)/i,
    'README must link contributor setup to development.md',
  );
});

test('the README excludes placeholders and retired product claims', () => {
  for (const [pattern, message] of [
    [/<!--\s*(?:BADGES?|SCREENSHOT(?: PLACEHOLDER)?)\s*-->|\b(?:badge|screenshot) placeholder\b/i, 'README must not contain badge or screenshot placeholders'],
    [/\b(?:Skills|Files)(?:\s*(?:and|&|\/|,)\s*(?:Skills|Files))?\s+(?:toolbar\s+)?buttons?\b|\b(?:toolbar\s+)?buttons?[^.\n]*(?:Skills|Files)\b/i, 'README must not instruct readers to use retired Skills or Files toolbar buttons'],
    [/\bAskUserQuestion\b|\b(?:structured\s+)?(?:question|prompt)[^\n.]*cards?\b/i, 'README must not promise structured question cards in bot sessions'],
    [/\bTauri\b/i, 'README must position the current Electron app, not the retired Tauri shell'],
    [/\bClaude(?: Code)?[- ]only\b|\bonly supports? Claude(?: Code)?\b|\bbuilt (?:only|exclusively) for Claude(?: Code)?\b/i, 'README must not frame Comate as Claude-only'],
  ] as const) {
    assert.doesNotMatch(readme, pattern, message);
  }
});

test('the script test suite includes the README contract', () => {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.match(
    packageJson.scripts?.['test:scripts'] ?? '',
    /(?:^|\s)scripts\/readme-contract\.test\.ts(?:\s|$)/,
    'test:scripts must run scripts/readme-contract.test.ts',
  );
});
