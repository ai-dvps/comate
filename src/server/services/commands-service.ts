import os from 'node:os';
import path from 'node:path';
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
import { loadClaudeSettings } from '../utils/claude-settings.js';

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

    const [projectEntries, skillEntries, personalEntries] = await Promise.all([
      loadCommandsDir(projectDir, 'project'),
      loadSkillsDir(skillsDir),
      loadCommandsDir(personalDir, 'personal'),
    ]);

    const fsCommandsByPath = new Map<string, FsCommandEntry>();
    for (const entry of [...projectEntries, ...skillEntries, ...personalEntries]) {
      fsCommandsByPath.set(entry.filePath, entry);
    }

    const state: WorkspaceCommandsState = {
      sdkCommands,
      fsCommandsByPath,
      partial: partialReason !== undefined,
      partialReason,
    };

    this.attachWatcher(workspace.folderPath, [projectDir, skillsDir]);

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

  private buildSdkOptions(workspace: Workspace): Options {
    const claudeSettings = loadClaudeSettings();
    const env: Record<string, string | undefined> = {
      ...claudeSettings,
      ...process.env,
    };
    if (workspace.settings.apiKey) {
      env.ANTHROPIC_API_KEY = workspace.settings.apiKey;
    }

    // Diagnostic: log Windows home-dir env vars
    sidecarLog(`[CommandsService.buildSdkOptions] USERPROFILE=${process.env.USERPROFILE}`);
    sidecarLog(`[CommandsService.buildSdkOptions] HOME=${process.env.HOME}`);
    sidecarLog(`[CommandsService.buildSdkOptions] HOMEDRIVE=${process.env.HOMEDRIVE}`);
    sidecarLog(`[CommandsService.buildSdkOptions] HOMEPATH=${process.env.HOMEPATH}`);
    sidecarLog(`[CommandsService.buildSdkOptions] homedir=${os.homedir()}`);

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
      model: workspace.settings.model || undefined,
      pathToClaudeCodeExecutable: claudePath,
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
  if (filePath.startsWith(commandsRoot)) {
    const base = path.basename(filePath);
    return base.endsWith('.md') ? 'project' : null;
  }
  if (filePath.startsWith(skillsRoot)) {
    return path.basename(filePath) === 'SKILL.md' ? 'skill' : null;
  }
  return null;
}

// Exposed only for tests that need to validate name extraction.
export { commandNameFromFilePath };

export const commandsService = new CommandsService();
