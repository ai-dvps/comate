import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canonicalVocabulary,
  controlPillars,
  financeScenarioStages,
  platformFacts,
  primaryCtaSlots,
  providerPrerequisite,
  releaseDestination,
  siteLocales,
} from './site-facts.js';

const localizedCollections = [
  canonicalVocabulary,
  controlPillars,
  financeScenarioStages,
  platformFacts,
  primaryCtaSlots,
];

describe('central site facts', () => {
  it('lists macOS, Windows, and Linux exactly once in display order', () => {
    expect(platformFacts.map(({ key }) => key)).toEqual(['macos', 'windows', 'linux']);
    expect(new Set(platformFacts.map(({ key }) => key))).toHaveLength(3);
  });

  it('uses the generic official HTTPS GitHub Releases destination', () => {
    const url = new URL(releaseDestination.url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('github.com');
    expect(url.pathname).toBe('/ai-dvps/comate/releases');
    expect(releaseDestination.kind).toBe('official-releases');
  });

  it('distinguishes draft setup from the Provider requirement for Agent execution', () => {
    expect(providerPrerequisite.workspaceAndDraftSessionAllowedWithoutProvider).toBe(true);
    expect(providerPrerequisite.agentExecutionRequiresConfiguredProvider).toBe(true);
    expect(providerPrerequisite.freeInferenceIncluded).toBe(false);

    for (const locale of siteLocales) {
      expect(providerPrerequisite.disclosure[locale]).toMatch(/Workspace|工作区/);
      expect(providerPrerequisite.disclosure[locale]).toMatch(/Provider/);
      expect(providerPrerequisite.disclosure[locale]).toMatch(/Agent|智能体/);
    }
  });

  it('keeps the product category general-purpose and Agent backend distinct from Provider', () => {
    const vocabulary = Object.fromEntries(
      canonicalVocabulary.map(({ key, label }) => [key, label])
    );
    expect(vocabulary['product-category'].en).toBe('general-purpose Agent task workspace');
    expect(vocabulary['agent-backend']).not.toEqual(vocabulary.provider);
    expect(vocabulary['agent-backend'].en).toMatch(/execution engine/i);
    expect(vocabulary.provider.en).toMatch(/model service configuration/i);
  });

  it('keeps all critical semantic keys and localized labels complete', () => {
    expect(controlPillars.map(({ key }) => key)).toEqual([
      'workspace-ownership',
      'agent-and-model-choice',
      'transparent-permissions',
      'skills-and-mcp-extensibility',
      'enterprise-environment-fit',
    ]);
    expect(financeScenarioStages.map(({ key }) => key)).toEqual([
      'request-through-im',
      'acknowledge-with-task-id',
      'use-approved-intelligence',
      'collect-and-analyze',
      'request-permission-or-attention',
      'publish-finished-report',
      'notify-with-status-and-link',
    ]);
    expect(primaryCtaSlots.map(({ key }) => key)).toEqual([
      'home-primary',
      'home-closing',
      'download-primary',
    ]);

    for (const collection of localizedCollections) {
      for (const item of collection) {
        for (const locale of siteLocales) {
          expect(item.label[locale]).toBeTruthy();
        }
      }
    }
  });

  it('does not export stale or misleading marketing claims', () => {
    const exportedFacts = JSON.stringify({
      canonicalVocabulary,
      controlPillars,
      financeScenarioStages,
      platformFacts,
      primaryCtaSlots,
      providerPrerequisite,
      releaseDestination,
    });

    for (const forbidden of [
      /tauri/i,
      /claude[- ]only/i,
      /fully local/i,
      /完全本地/,
      /mac(?:os)?\s*(?:&|and|与|和)\s*windows/i,
    ]) {
      expect(exportedFacts).not.toMatch(forbidden);
    }
  });
});

describe('upstream Electron release compatibility', () => {
  it('matches stable platform markers in packaging and release authorities', async () => {
    // These root files remain authoritative. This test deliberately checks only
    // explicit platform/target markers so harmless prose or formatting changes
    // do not couple the website projection to the entire upstream files.
    const [builderConfig, buildWorkflow, packageMetadata] = await Promise.all([
      readFile(new URL('../../../electron-builder.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../.github/workflows/build.yml', import.meta.url), 'utf8'),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ]);

    expect(builderConfig).toMatch(/import type \{ Configuration \} from 'electron-builder'/);
    const platformBlock = (key: 'mac' | 'win' | 'linux') =>
      builderConfig.match(new RegExp(`^  ${key}: \\{\\n([\\s\\S]*?)^  \\},`, 'm'))?.[1] ?? '';
    expect(platformBlock('mac')).toMatch(/target:\s*\['dmg', 'zip'\]/);
    expect(platformBlock('win')).toMatch(/target:\s*\['nsis'\]/);
    expect(platformBlock('linux')).toMatch(/target:\s*\['AppImage', 'deb'\]/);

    expect(buildWorkflow).toMatch(/platform: macos-latest[\s\S]*?builder-args: '--mac --x64 --arm64'/);
    expect(buildWorkflow).toMatch(/platform: windows-2022[\s\S]*?builder-args: '--win'/);
    expect(buildWorkflow).toMatch(/platform: ubuntu-22\.04[\s\S]*?builder-args: '--linux'/);
    expect(buildWorkflow).toContain('electron-builder --config electron-builder.config.ts');

    const packageJson = JSON.parse(packageMetadata) as {
      main?: string;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.main).toMatch(/^dist-electron\//);
    expect(packageJson.devDependencies?.electron).toBeTruthy();
    expect(packageJson.devDependencies?.['electron-builder']).toBeTruthy();
  });
});
