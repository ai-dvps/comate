import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readPluginSettings,
  addExtraKnownMarketplace,
  resolveGlobalClaudeSettingsPath,
  type KnownMarketplace,
} from './claude-settings.js';

describe('claude-settings', { concurrency: false }, () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'comate-claude-settings-test-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = join(tempDir, 'user');
    mkdirSync(join(tempDir, 'user', '.claude'), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function userSettingsPath(): string {
    return resolveGlobalClaudeSettingsPath().settingsPath;
  }

  function writeUserSettings(content: unknown): void {
    const path = userSettingsPath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(content, null, 2), 'utf-8');
  }

  function readUserSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(userSettingsPath(), 'utf-8')) as Record<string, unknown>;
  }

  describe('readPluginSettings', () => {
    it('parses directory-type extraKnownMarketplaces', () => {
      writeUserSettings({
        extraKnownMarketplaces: {
          'comate-built-in': {
            source: {
              source: 'directory',
              path: '/opt/comate/claude-code-plugin',
            },
          },
        },
      });

      const settings = readPluginSettings(userSettingsPath());
      assert.deepStrictEqual(settings.extraKnownMarketplaces['comate-built-in'], {
        source: {
          source: 'directory',
          path: '/opt/comate/claude-code-plugin',
        },
      });
    });

    it('parses github-type extraKnownMarketplaces', () => {
      writeUserSettings({
        extraKnownMarketplaces: {
          'my-marketplace': {
            source: {
              source: 'github',
              repo: 'acme/claude-plugins',
            },
          },
        },
      });

      const settings = readPluginSettings(userSettingsPath());
      assert.deepStrictEqual(settings.extraKnownMarketplaces['my-marketplace'], {
        source: {
          source: 'github',
          repo: 'acme/claude-plugins',
        },
      });
    });

    it('ignores malformed marketplace entries', () => {
      writeUserSettings({
        extraKnownMarketplaces: {
          'good-marketplace': {
            source: {
              source: 'directory',
              path: '/valid/path',
            },
          },
          'bad-marketplace': {
            source: {
              source: 'directory',
              // missing path
            },
          },
          'unsupported-marketplace': {
            source: {
              source: 'ftp',
              url: 'ftp://example.com',
            },
          },
        },
      });

      const settings = readPluginSettings(userSettingsPath());
      assert.ok(settings.extraKnownMarketplaces['good-marketplace']);
      assert.ok(!settings.extraKnownMarketplaces['bad-marketplace']);
      assert.ok(!settings.extraKnownMarketplaces['unsupported-marketplace']);
    });
  });

  describe('addExtraKnownMarketplace', () => {
    it('adds a new marketplace entry', () => {
      const marketplace: KnownMarketplace = {
        source: {
          source: 'directory',
          path: '/opt/comate/claude-code-plugin',
        },
      };

      addExtraKnownMarketplace('comate-built-in', marketplace);

      const settings = readUserSettings();
      assert.deepStrictEqual(
        (settings.extraKnownMarketplaces as Record<string, unknown>)['comate-built-in'],
        {
          source: {
            source: 'directory',
            path: '/opt/comate/claude-code-plugin',
          },
        },
      );
    });

    it('updates the path when it changes', () => {
      writeUserSettings({
        extraKnownMarketplaces: {
          'comate-built-in': {
            source: {
              source: 'directory',
              path: '/old/path',
            },
          },
        },
      });

      addExtraKnownMarketplace('comate-built-in', {
        source: {
          source: 'directory',
          path: '/new/path',
        },
      });

      const settings = readUserSettings();
      assert.deepStrictEqual(
        (settings.extraKnownMarketplaces as Record<string, unknown>)['comate-built-in'],
        {
          source: {
            source: 'directory',
            path: '/new/path',
          },
        },
      );
    });

    it('is idempotent when the entry already matches', () => {
      const initial = {
        extraKnownMarketplaces: {
          'comate-built-in': {
            source: {
              source: 'directory',
              path: '/opt/comate/claude-code-plugin',
            },
          },
        },
      };
      writeUserSettings(initial);
      const before = readFileSync(userSettingsPath(), 'utf-8');

      addExtraKnownMarketplace('comate-built-in', {
        source: {
          source: 'directory',
          path: '/opt/comate/claude-code-plugin',
        },
      });

      const after = readFileSync(userSettingsPath(), 'utf-8');
      assert.strictEqual(before, after);
    });

    it('preserves unrelated keys and other marketplace entries', () => {
      writeUserSettings({
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        enabledPlugins: {
          'formatter@marketplace': true,
        },
        extraKnownMarketplaces: {
          'user-marketplace': {
            source: {
              source: 'github',
              repo: 'user/claude-plugins',
            },
          },
        },
      });

      addExtraKnownMarketplace('comate-built-in', {
        source: {
          source: 'directory',
          path: '/opt/comate/claude-code-plugin',
        },
      });

      const settings = readUserSettings();
      assert.strictEqual((settings.env as Record<string, string>).ANTHROPIC_API_KEY, 'sk-test');
      assert.deepStrictEqual(settings.enabledPlugins, { 'formatter@marketplace': true });
      assert.deepStrictEqual(
        (settings.extraKnownMarketplaces as Record<string, unknown>)['user-marketplace'],
        {
          source: {
            source: 'github',
            repo: 'user/claude-plugins',
          },
        },
      );
      assert.ok((settings.extraKnownMarketplaces as Record<string, unknown>)['comate-built-in']);
    });

    it('creates settings.json when it does not exist', () => {
      const path = userSettingsPath();
      assert.ok(!existsSync(path));

      addExtraKnownMarketplace('comate-built-in', {
        source: {
          source: 'directory',
          path: '/opt/comate/claude-code-plugin',
        },
      });

      assert.ok(existsSync(path));
      const settings = readUserSettings();
      assert.ok((settings.extraKnownMarketplaces as Record<string, unknown>)['comate-built-in']);
    });
  });
});