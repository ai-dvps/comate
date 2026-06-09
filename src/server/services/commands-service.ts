import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import type { Workspace } from '../models/workspace.js';
import type { CachedCommandList, CommandSource } from '../types/commands.js';
import type { SlashCommandDto } from '../types/initialization.js';
import {
  commandNameFromFilePath,
  parseCommandFile,
  parseCommandsDir,
  parseSkillsDir,
} from './command-fs-parser.js';
import { SdkClient } from './sdk-client.js';
import type { Options } from './sdk-client.js';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';
import { sidecarLog } from '../utils/sidecar-logger.js';
import { buildClaudeEnv, getPathEnvKey } from '../utils/sdk-env.js';
import { loadClaudeSettings } from '../utils/claude-settings.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { pluginSettingsService } from './plugin-settings-service.js';

interface FsCommandEntry {
  filePath: string;
  source: CommandSource;
  dto: SlashCommandDto;
}

interface WorkspaceCommandsState {
  sdkCommands: SlashCommandDto[];
  fsCommandsByPath: Map<string, FsCommandEntry>;
  partial: boolean;
  partialReason?: string;
}

const SOURCE_PRIORITY: Record<CommandSource, number> = {
  project: 0,
  skill: 1,
  plugin: 1,
  personal: 2,
};

export class CommandsService {
  private sdkClient: SdkClient;
  private cache = new Map<string, WorkspaceCommandsState>();
  private inflight = new Map<string, Promise<CachedCommandList>>();
  private watchers = new Map<string, FSWatcher>();

  constructor(sdkClient: SdkClient = new SdkClient()) {
    this.sdkClient = sdkClient;
  }

  async getCommands(workspace: Workspace): Promise<CachedCommandList> {
    const key = workspace.folderPath;

    const cached = this.cache.get(key);
    if (cached) return this.deriveList(cached);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const state = await this.populate(workspace);
      this.cache.set(key, state);
      return this.deriveList(state);
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  async dispose(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const watcher of this.watchers.values()) {
      closing.push(watcher.close());
    }
    this.watchers.clear();
    this.cache.clear();
    this.inflight.clear();
    await Promise.all(closing);
  }

  private async populate(workspace: Workspace): Promise<WorkspaceCommandsState> {
    const options = this.buildSdkOptions(workspace);

    let sdkCommands: SlashCommandDto[] = [];
    let partialReason: string | undefined;
    try {
      const init = await this.sdkClient.fetchInitialization(options);
      sdkCommands = init.commands;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[commands] SDK initialization failed for ${workspace.folderPath}: ${message}`,
      );
      partialReason = `SDK initialization failed: ${message}`;
    }

    const projectDir = path.join(workspace.folderPath, '.claude/commands');
    const skillsDir = path.join(workspace.folderPath, '.claude/skills');
    const personalDir = path.join(os.homedir(), '.claude/commands');

    const [projectEntries, skillEntries, personalEntries, pluginEntries] = await Promise.all([
      loadCommandsDir(projectDir, 'project'),
      loadSkillsDir(skillsDir),
      loadCommandsDir(personalDir, 'personal'),
      this.loadPluginEntries(workspace.folderPath),
    ]);

    const fsCommandsByPath = new Map<string, FsCommandEntry>();
    for (const entry of [...projectEntries, ...skillEntries, ...personalEntries, ...pluginEntries]) {
      fsCommandsByPath.set(entry.filePath, entry);
    }

    const state: WorkspaceCommandsState = {
      sdkCommands,
      fsCommandsByPath,
      partial: partialReason !== undefined,
      partialReason,
    };

    const pluginDirs = pluginEntries.map((e) => path.dirname(e.filePath));
    this.attachWatcher(workspace.folderPath, [projectDir, skillsDir, ...pluginDirs]);

    return state;
  }

  private deriveList(state: WorkspaceCommandsState): CachedCommandList {
    const merged: SlashCommandDto[] = [];
    const seen = new Set<string>();

    for (const cmd of state.sdkCommands) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      merged.push(cmd);
    }

    const fsSorted = [...state.fsCommandsByPath.values()].sort(
      (a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source],
    );
    for (const entry of fsSorted) {
      if (seen.has(entry.dto.name)) continue;
      seen.add(entry.dto.name);
      merged.push(entry.dto);
    }

    return {
      commands: merged,
      partial: state.partial,
      partialReason: state.partialReason,
    };
  }

  private attachWatcher(folderPath: string, paths: string[]): void {
    if (this.watchers.has(folderPath)) return;

    const watcher = watch(paths, {
      ignoreInitial: true,
      persistent: true,
      depth: 4,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    watcher.on('add', (filePath) => {
      this.handleFsUpsert(folderPath, filePath).catch((err) => {
        console.error(`[commands] watcher add failed for ${filePath}:`, err);
      });
    });
    watcher.on('change', (filePath) => {
      this.handleFsUpsert(folderPath, filePath).catch((err) => {
        console.error(`[commands] watcher change failed for ${filePath}:`, err);
      });
    });
    watcher.on('unlink', (filePath) => {
      this.handleFsRemove(folderPath, filePath);
    });
    watcher.on('unlinkDir', (dirPath) => {
      this.handleFsRemoveDir(folderPath, dirPath);
    });
    watcher.on('error', (err) => {
      console.error(`[commands] watcher error for ${folderPath}:`, err);
    });

    this.watchers.set(folderPath, watcher);
  }

  private async handleFsUpsert(folderPath: string, filePath: string): Promise<void> {
    const state = this.cache.get(folderPath);
    if (!state) return;

    const source = sourceForPath(filePath, folderPath);
    if (!source) return;

    const dto = await parseCommandFile(filePath);
    if (!dto) return;

    state.fsCommandsByPath.set(filePath, { filePath, source, dto });
  }

  private handleFsRemove(folderPath: string, filePath: string): void {
    const state = this.cache.get(folderPath);
    if (!state) return;
    state.fsCommandsByPath.delete(filePath);
  }

  private handleFsRemoveDir(folderPath: string, dirPath: string): void {
    const state = this.cache.get(folderPath);
    if (!state) return;
    const prefix = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep;
    for (const key of [...state.fsCommandsByPath.keys()]) {
      if (key.startsWith(prefix)) state.fsCommandsByPath.delete(key);
    }
  }

  private async loadPluginEntries(workspacePath: string): Promise<FsCommandEntry[]> {
    const entries: FsCommandEntry[] = [];
    const seenPlugins = new Set<string>();

    try {
      // Get enabled plugins from all three scopes
      // Order matters: local takes precedence over project over user
      const userPlugins = pluginSettingsService.getInstalledPlugins('user');
      const projectPlugins = pluginSettingsService.getInstalledPlugins('project', workspacePath);
      const localPlugins = pluginSettingsService.getInstalledPlugins('local', workspacePath);

      const enabledPlugins = [
        ...localPlugins.filter((p) => p.enabled),
        ...projectPlugins.filter((p) => p.enabled),
        ...userPlugins.filter((p) => p.enabled),
      ];

      for (const plugin of enabledPlugins) {
        if (seenPlugins.has(plugin.id)) continue;
        seenPlugins.add(plugin.id);

        const cachePath = pluginSettingsService.resolvePluginCachePath(plugin.id);
        const manifest = pluginSettingsService.readPluginManifest(plugin.id);
        if (!manifest) {
          console.warn(`[commands] Plugin ${plugin.id} has no valid manifest, skipping`);
          continue;
        }

        const pluginCommandsDir = path.join(cachePath, '.claude-plugin', 'commands');
        const pluginSkillsDir = path.join(cachePath, '.claude-plugin', 'skills');
        const altCommandsDir = path.join(cachePath, 'commands');
        const altSkillsDir = path.join(cachePath, 'skills');

        const [commandDtos, skillDtos] = await Promise.all([
          parseCommandsDir(existsSync(pluginCommandsDir) ? pluginCommandsDir : altCommandsDir),
          parseSkillsDir(existsSync(pluginSkillsDir) ? pluginSkillsDir : altSkillsDir),
        ]);

        for (const dto of commandDtos) {
          const filePath = path.join(
            existsSync(pluginCommandsDir) ? pluginCommandsDir : altCommandsDir,
            `${dto.name}.md`,
          );
          entries.push({ filePath, source: 'plugin', dto });
        }

        for (const dto of skillDtos) {
          const skillDir = existsSync(pluginSkillsDir) ? pluginSkillsDir : altSkillsDir;
          const filePath = path.join(skillDir, dto.name, 'SKILL.md');
          entries.push({ filePath, source: 'plugin', dto });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[commands] Plugin discovery failed: ${message}`);
    }

    return entries;
  }

  private buildSdkOptions(workspace: Workspace): Options {
    const claudeSettings = loadClaudeSettings();
    const { env, sources: envSources } = buildClaudeEnv(claudeSettings);

    // Use default provider for command discovery (no session context)
    const provider = workspaceStore.getDefaultProvider();
    if (provider) {
      env.ANTHROPIC_BASE_URL = provider.baseUrl;
      env.ANTHROPIC_API_KEY = provider.authToken;
      if (provider.model) {
        env.ANTHROPIC_MODEL = provider.model;
      }
      if (provider.defaultOpusModel) {
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.defaultOpusModel;
      }
      if (provider.defaultSonnetModel) {
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.defaultSonnetModel;
      }
      if (provider.defaultHaikuModel) {
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.defaultHaikuModel;
      }
      if (provider.subagentModel) {
        env.CLAUDE_CODE_SUBAGENT_MODEL = provider.subagentModel;
      }
      if (provider.effortLevel) {
        env.CLAUDE_CODE_EFFORT_LEVEL = provider.effortLevel;
      }
      if (provider.customEnvVars) {
        for (const [key, value] of Object.entries(provider.customEnvVars)) {
          env[key] = value;
        }
      }
    }

    // Diagnostic: log Windows home-dir env vars
    sidecarLog(`[CommandsService.buildSdkOptions] USERPROFILE=${process.env.USERPROFILE}`);
    sidecarLog(`[CommandsService.buildSdkOptions] HOME=${process.env.HOME}`);
    sidecarLog(`[CommandsService.buildSdkOptions] HOMEDRIVE=${process.env.HOMEDRIVE}`);
    sidecarLog(`[CommandsService.buildSdkOptions] HOMEPATH=${process.env.HOMEPATH}`);
    sidecarLog(`[CommandsService.buildSdkOptions] homedir=${os.homedir()}`);
    sidecarLog(`[CommandsService.buildSdkOptions] CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`);
    sidecarLog(`[CommandsService.buildSdkOptions] CLAUDE_SECURESTORAGE_CONFIG_DIR=${env.CLAUDE_SECURESTORAGE_CONFIG_DIR}`);
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_') && env[key]) {
        sidecarLog(`[CommandsService.buildSdkOptions] env.${key}=<set> source=${envSources[key] ?? 'process'}`);
      }
    }

    const pathKey = getPathEnvKey(env);
    sidecarLog(`[CommandsService.buildSdkOptions] enriched PATH=${env[pathKey]}`);

    const mcpServers: Record<
      string,
      import('@anthropic-ai/claude-agent-sdk').McpServerConfig
    > = {};
    for (const mcp of workspace.mcpServers) {
      mcpServers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
      };
    }

    const claudePath = resolveSdkBinary();
    sidecarLog(`[CommandsService.buildSdkOptions] pathToClaudeCodeExecutable=${claudePath}`);
    return {
      cwd: workspace.folderPath,
      env,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: provider?.model || undefined,
      pathToClaudeCodeExecutable: claudePath,
      stderr: (data) => {
        const trimmed = data.trim();
        if (trimmed) sidecarLog(`[CommandsService.claude.stderr] ${trimmed}`);
      },
    };
  }
}

async function loadCommandsDir(
  dir: string,
  source: CommandSource,
): Promise<FsCommandEntry[]> {
  const dtos = await parseCommandsDir(dir);
  return dtos
    .map((dto) => {
      const filePath = path.join(dir, `${dto.name}.md`);
      return { filePath, source, dto };
    })
    .filter((entry): entry is FsCommandEntry => entry.dto.name.length > 0);
}

async function loadSkillsDir(dir: string): Promise<FsCommandEntry[]> {
  const dtos = await parseSkillsDir(dir);
  return dtos.map((dto) => {
    const filePath = path.join(dir, dto.name, 'SKILL.md');
    return { filePath, source: 'skill' as const, dto };
  });
}

function sourceForPath(filePath: string, workspaceFolder: string): CommandSource | null {
  const commandsRoot = path.join(workspaceFolder, '.claude/commands') + path.sep;
  const skillsRoot = path.join(workspaceFolder, '.claude/skills') + path.sep;
  const pluginCacheRoot = path.join(os.homedir(), '.claude/plugins/cache') + path.sep;
  if (filePath.startsWith(commandsRoot)) {
    const base = path.basename(filePath);
    return base.endsWith('.md') ? 'project' : null;
  }
  if (filePath.startsWith(skillsRoot)) {
    return path.basename(filePath) === 'SKILL.md' ? 'skill' : null;
  }
  if (filePath.startsWith(pluginCacheRoot)) {
    const base = path.basename(filePath);
    return base.endsWith('.md') ? 'plugin' : null;
  }
  return null;
}

// Exposed only for tests that need to validate name extraction.
export { commandNameFromFilePath };

export const commandsService = new CommandsService();
