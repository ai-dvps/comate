import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, existsSync, rmSync, cpSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';
import { sidecarLog } from './sidecar-logger.js';

export interface DownloadResult {
  success: boolean;
  cachePath: string;
  error?: string;
}

export interface PluginDownloaderOptions {
  cacheDir: string;
  timeoutMs?: number;
}

export class PluginDownloader {
  private cacheDir: string;
  private timeoutMs: number;

  constructor(options: PluginDownloaderOptions) {
    this.cacheDir = options.cacheDir;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  /**
   * Download a plugin from a git repository.
   */
  async downloadGit(
    pluginId: string,
    gitUrl: string,
    ref?: string,
  ): Promise<DownloadResult> {
    const cachePath = join(this.cacheDir, pluginId);
    const tempPath = `${cachePath}.tmp-${Date.now()}`;

    try {
      // Remove existing cache if present (for updates)
      if (existsSync(cachePath)) {
        rmSync(cachePath, { recursive: true, force: true });
      }

      await this.runGitClone(gitUrl, tempPath, ref);

      // Validate manifest before moving to final location
      const manifestValid = await this.validateManifest(tempPath);
      if (!manifestValid) {
        rmSync(tempPath, { recursive: true, force: true });
        return {
          success: false,
          cachePath,
          error: `Downloaded plugin is missing a valid plugin.json manifest`,
        };
      }

      // Atomic move
      mkdirSync(this.cacheDir, { recursive: true });
      // On Windows, rename across directories may fail; use recursive copy then delete
      // For simplicity, we rename the temp directory to the cache path
      const { renameSync } = await import('fs');
      renameSync(tempPath, cachePath);

      sidecarLog(`[PluginDownloader] Downloaded ${pluginId} from ${gitUrl} to ${cachePath}`);
      return { success: true, cachePath };
    } catch (err) {
      // Cleanup temp on failure
      try {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }

      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[PluginDownloader] Git download failed for ${pluginId}: ${message}`);
      return { success: false, cachePath, error: message };
    }
  }

  /**
   * Download a plugin from a zip archive URL.
   */
  async downloadZip(
    pluginId: string,
    zipUrl: string,
  ): Promise<DownloadResult> {
    const cachePath = join(this.cacheDir, pluginId);
    const tempZip = join(tmpdir(), `comate-plugin-${pluginId}-${Date.now()}.zip`);
    const tempExtract = join(tmpdir(), `comate-plugin-${pluginId}-${Date.now()}`);

    try {
      // Remove existing cache if present
      if (existsSync(cachePath)) {
        rmSync(cachePath, { recursive: true, force: true });
      }

      // Download zip to temp file
      await this.downloadFile(zipUrl, tempZip);

      // Extract to temp directory
      mkdirSync(tempExtract, { recursive: true });
      const zip = new AdmZip(tempZip);
      zip.extractAllTo(tempExtract, true);

      // Find the actual plugin root (zip may contain a nested directory)
      const pluginRoot = await this.findPluginRoot(tempExtract);

      // Validate manifest
      const manifestValid = await this.validateManifest(pluginRoot);
      if (!manifestValid) {
        return {
          success: false,
          cachePath,
          error: `Downloaded plugin is missing a valid plugin.json manifest`,
        };
      }

      // Move to cache
      mkdirSync(this.cacheDir, { recursive: true });
      const { renameSync } = await import('fs');
      renameSync(pluginRoot, cachePath);

      sidecarLog(`[PluginDownloader] Downloaded ${pluginId} from ${zipUrl} to ${cachePath}`);
      return { success: true, cachePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[PluginDownloader] Zip download failed for ${pluginId}: ${message}`);
      return { success: false, cachePath, error: message };
    } finally {
      // Cleanup temps
      try {
        if (existsSync(tempZip)) rmSync(tempZip, { force: true });
        if (existsSync(tempExtract)) rmSync(tempExtract, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  /**
   * Download from a generic source URL (auto-detect git vs zip).
   */
  async downloadFromUrl(
    pluginId: string,
    url: string,
  ): Promise<DownloadResult> {
    const isGitUrl =
      url.endsWith('.git') ||
      url.startsWith('git@') ||
      url.includes('github.com') ||
      url.includes('gitlab.com');

    if (isGitUrl) {
      return this.downloadGit(pluginId, url);
    }

    return this.downloadZip(pluginId, url);
  }

  /**
   * Copy a plugin from a local directory into the cache.
   */
  async downloadLocal(
    pluginId: string,
    localPath: string,
  ): Promise<DownloadResult> {
    const cachePath = join(this.cacheDir, pluginId);

    try {
      if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
        return {
          success: false,
          cachePath,
          error: `Local plugin path does not exist or is not a directory: ${localPath}`,
        };
      }

      // Remove existing cache if present (for updates)
      if (existsSync(cachePath)) {
        rmSync(cachePath, { recursive: true, force: true });
      }

      // Validate manifest before copying
      const manifestValid = await this.validateManifest(localPath);
      if (!manifestValid) {
        return {
          success: false,
          cachePath,
          error: `Local plugin is missing a valid plugin.json manifest`,
        };
      }

      mkdirSync(this.cacheDir, { recursive: true });
      cpSync(localPath, cachePath, { recursive: true, dereference: true });

      sidecarLog(`[PluginDownloader] Copied ${pluginId} from ${localPath} to ${cachePath}`);
      return { success: true, cachePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecarLog(`[PluginDownloader] Local copy failed for ${pluginId}: ${message}`);
      return { success: false, cachePath, error: message };
    }
  }

  private async runGitClone(
    gitUrl: string,
    targetPath: string,
    ref?: string,
  ): Promise<void> {
    const args = ['clone', '--depth', '1'];
    if (ref) {
      args.push('--branch', ref);
    }
    args.push(gitUrl, targetPath);

    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Git clone timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Git clone failed (exit ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async downloadFile(url: string, targetPath: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Comate-Plugin-Manager/1.0',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response has no body');
      }

      const fileStream = createWriteStream(targetPath);
      await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  private async findPluginRoot(extractDir: string): Promise<string> {
    // If the zip contains a single directory, use that as the plugin root
    const { readdirSync, statSync } = await import('fs');
    const entries = readdirSync(extractDir);

    if (entries.length === 1) {
      const candidate = join(extractDir, entries[0]);
      const stats = statSync(candidate);
      if (stats.isDirectory()) {
        // Check if this directory has plugin.json or a .claude-plugin subdirectory
        if (
          existsSync(join(candidate, 'plugin.json')) ||
          existsSync(join(candidate, '.claude-plugin', 'plugin.json'))
        ) {
          return candidate;
        }
      }
    }

    return extractDir;
  }

  private async validateManifest(pluginDir: string): Promise<boolean> {
    try {
      const { readFileSync } = await import('fs');
      const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
      const altPath = join(pluginDir, 'plugin.json');

      for (const p of [manifestPath, altPath]) {
        if (!existsSync(p)) continue;
        const content = readFileSync(p, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return typeof parsed.name === 'string' && typeof parsed.version === 'string';
      }
      return false;
    } catch {
      return false;
    }
  }
}
