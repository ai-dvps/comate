import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sidecarLog } from '../utils/sidecar-logger.js';
import { readKnownMarketplacesFile } from '../utils/claude-settings.js';

export interface MarketplacePlugin {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  author?: string;
  keywords?: string[];
  sourceMarketplace: string;
  sourceUrl?: string;
  sourceType?: 'git' | 'zip';
}

export interface MarketplaceRegistry {
  name: string;
  url: string;
  githubRepo?: string;
}

export interface MarketplaceFetchResult {
  plugins: MarketplacePlugin[];
  errors: { marketplace: string; error: string }[];
}

/** Raw marketplace.json format from a GitHub repo */
interface ClaudeMarketplaceJson {
  name?: string;
  owner?: { name?: string; url?: string };
  metadata?: { description?: string; version?: string };
  plugins?: ClaudeMarketplacePluginEntry[];
}

interface ClaudeMarketplacePluginEntry {
  name?: string;
  description?: string;
  author?: string | { name?: string; url?: string; email?: string };
  homepage?: string;
  tags?: string[];
  source?: string;
  version?: string;
  category?: string;
}

export class MarketplaceService {
  private defaultRegistries: MarketplaceRegistry[] = [
    { name: 'Claude Code Marketplace', url: 'https://code.claude.com/api/plugins' },
  ];

  /**
   * Fetch plugins from all configured marketplaces.
   */
  async fetchMarketplaces(
    customRegistries: MarketplaceRegistry[] = [],
    query?: string,
  ): Promise<MarketplaceFetchResult> {
    const registries = [...this.defaultRegistries, ...customRegistries];
    const allPlugins: MarketplacePlugin[] = [];
    const errors: { marketplace: string; error: string }[] = [];

    await Promise.all(
      registries.map(async (registry) => {
        try {
          let plugins: MarketplacePlugin[];
          if (registry.githubRepo) {
            plugins = await this.fetchGitHubMarketplace(registry.githubRepo, registry.name);
          } else {
            plugins = await this.fetchRegistry(registry);
          }
          allPlugins.push(...plugins);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sidecarLog(`[MarketplaceService] Failed to fetch ${registry.name}: ${message}`);
          errors.push({ marketplace: registry.name, error: message });
        }
      }),
    );

    // Deduplicate by id + sourceMarketplace, preferring higher-version entries
    const deduped = this.deduplicatePlugins(allPlugins);

    // Apply search filter if query provided
    const filtered = query ? this.filterPlugins(deduped, query) : deduped;

    return { plugins: filtered, errors };
  }

  /**
   * Fetch a single JSON registry.
   */
  private async fetchRegistry(registry: MarketplaceRegistry): Promise<MarketplacePlugin[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(registry.url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as unknown;
    const plugins = this.parseRegistryResponse(data, registry.name);
    sidecarLog(`[MarketplaceService] Fetched ${plugins.length} plugins from ${registry.name}`);
    return plugins;
  }

  /**
   * Fetch a GitHub repo-based marketplace by reading .claude-plugin/marketplace.json
   */
  private async fetchGitHubMarketplace(repo: string, marketplaceName: string): Promise<MarketplacePlugin[]> {
    const branches = ['main', 'master'];
    let lastError: Error | undefined;

    for (const branch of branches) {
      const url = `https://raw.githubusercontent.com/${repo}/${branch}/.claude-plugin/marketplace.json`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          if (response.status === 404) {
            lastError = new Error(`marketplace.json not found on ${branch}`);
            continue;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as unknown;
        const plugins = this.parseMarketplaceJson(data, repo, marketplaceName);
        sidecarLog(`[MarketplaceService] Fetched ${plugins.length} plugins from GitHub repo ${repo}`);
        return plugins;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Request timeout');
        }
        // Continue to next branch on 404
      }
    }

    throw lastError || new Error('Failed to fetch marketplace.json from GitHub repo');
  }

  /**
   * Parse a Claude Code marketplace.json file.
   */
  private parseMarketplaceJson(data: unknown, repo: string, marketplaceName: string): MarketplacePlugin[] {
    if (!data || typeof data !== 'object') return [];
    const mp = data as ClaudeMarketplaceJson;
    const items = Array.isArray(mp.plugins) ? mp.plugins : [];

    return items
      .map((item) => this.normalizeMarketplaceEntry(item, repo, marketplaceName))
      .filter((p): p is MarketplacePlugin => p !== null);
  }

  private normalizeMarketplaceEntry(
    item: ClaudeMarketplacePluginEntry,
    repo: string,
    marketplaceName: string,
  ): MarketplacePlugin | null {
    if (!item || typeof item !== 'object') return null;

    const name = typeof item.name === 'string' ? item.name : null;
    if (!name) return null;

    const version = typeof item.version === 'string' ? item.version : '0.0.0';

    // Resolve author string from author object if needed
    let author: string | undefined;
    if (typeof item.author === 'string') {
      author = item.author;
    } else if (item.author && typeof item.author === 'object') {
      const a = item.author as { name?: string; url?: string; email?: string };
      author = a.name ?? undefined;
    }

    // Construct sourceUrl from repo + relative source path
    let sourceUrl: string | undefined;
    if (typeof item.source === 'string') {
      // source is like "./plugins/compound-engineering" — point to the full repo for cloning
      sourceUrl = `https://github.com/${repo}.git`;
    } else if (typeof item.homepage === 'string') {
      sourceUrl = item.homepage;
    }

    return {
      id: name,
      name,
      displayName: name,
      description: typeof item.description === 'string' ? item.description : undefined,
      version,
      author,
      keywords: Array.isArray(item.tags)
        ? (item.tags as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
      sourceMarketplace: marketplaceName,
      sourceUrl,
      sourceType: 'git',
    };
  }

  /**
   * Parse registry response. Accepts both array and { plugins: [...] } shapes.
   */
  private parseRegistryResponse(data: unknown, marketplaceName: string): MarketplacePlugin[] {
    let items: unknown[];

    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      items = Array.isArray(obj.plugins) ? obj.plugins : [];
    } else {
      return [];
    }

    return items
      .map((item) => this.normalizePluginEntry(item, marketplaceName))
      .filter((p): p is MarketplacePlugin => p !== null);
  }

  private normalizePluginEntry(item: unknown, marketplaceName: string): MarketplacePlugin | null {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;

    const name = typeof obj.name === 'string' ? obj.name : null;
    if (!name) return null;

    const version = typeof obj.version === 'string' ? obj.version : '0.0.0';

    return {
      id: name,
      name,
      displayName: typeof obj.displayName === 'string' ? obj.displayName : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      version,
      author: typeof obj.author === 'string' ? obj.author : undefined,
      keywords: Array.isArray(obj.keywords)
        ? (obj.keywords as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
      sourceMarketplace: marketplaceName,
      sourceUrl: typeof obj.sourceUrl === 'string' ? obj.sourceUrl : undefined,
      sourceType: obj.sourceType === 'git' || obj.sourceType === 'zip' ? obj.sourceType : undefined,
    };
  }

  private deduplicatePlugins(plugins: MarketplacePlugin[]): MarketplacePlugin[] {
    const byId = new Map<string, MarketplacePlugin>();

    for (const plugin of plugins) {
      const key = `${plugin.id}@${plugin.sourceMarketplace}`;
      const existing = byId.get(key);
      if (!existing || this.compareVersions(plugin.version, existing.version) > 0) {
        byId.set(key, plugin);
      }
    }

    return [...byId.values()];
  }

  filterPlugins(plugins: MarketplacePlugin[], query: string): MarketplacePlugin[] {
    const lower = query.toLowerCase().trim();
    if (!lower) return plugins;

    return plugins.filter((p) => {
      const searchable = [
        p.name,
        p.displayName,
        p.description,
        p.author,
        ...(p.keywords || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(lower);
    });
  }

  /**
   * Load marketplace plugins from Claude Code's cached marketplace data on disk.
   * Reads ~/.claude/plugins/known_marketplaces.json and parses each installLocation
   * to extract the marketplace manifest without any network calls.
   *
   * This gives the same view as Claude Code CLI's internal marketplace cache.
   */
  loadCachedMarketplaces(): {
    plugins: MarketplacePlugin[];
    errors: { marketplace: string; error: string }[];
  } {
    const knownMarketplaces = readKnownMarketplacesFile();
    const allPlugins: MarketplacePlugin[] = [];
    const errors: { marketplace: string; error: string }[] = [];

    for (const [name, entry] of Object.entries(knownMarketplaces)) {
      try {
        if (!entry.installLocation) {
          errors.push({ marketplace: name, error: 'Missing installLocation' });
          continue;
        }

        // For git/github sources, marketplace.json is at .claude-plugin/marketplace.json
        // For url/file sources, installLocation is the file itself
        const nestedPath = join(entry.installLocation, '.claude-plugin', 'marketplace.json');
        let marketplacePath: string;
        if (existsSync(nestedPath)) {
          marketplacePath = nestedPath;
        } else if (existsSync(entry.installLocation)) {
          marketplacePath = entry.installLocation;
        } else {
          errors.push({ marketplace: name, error: `Cache not found at ${entry.installLocation}` });
          continue;
        }

        const content = readFileSync(marketplacePath, 'utf-8');
        const data = JSON.parse(content) as unknown;

        // Determine the github repo for sourceUrl construction
        let githubRepo: string | undefined;
        if (entry.source.source === 'github' && entry.source.repo) {
          githubRepo = entry.source.repo;
        }

        const plugins = this.parseMarketplaceJson(data, githubRepo || name, name);
        sidecarLog(`[MarketplaceService] Loaded ${plugins.length} plugins from cached marketplace ${name}`);
        allPlugins.push(...plugins);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sidecarLog(`[MarketplaceService] Failed to load cached marketplace ${name}: ${message}`);
        errors.push({ marketplace: name, error: message });
      }
    }

    return { plugins: allPlugins, errors };
  }

  /**
   * Compare two semver-like version strings.
   * Returns >0 if a > b, <0 if a < b, 0 if equal.
   */
  compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const na = Number.isFinite(partsA[i]) ? partsA[i] : 0;
      const nb = Number.isFinite(partsB[i]) ? partsB[i] : 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  /**
   * Check if a newer version is available for an installed plugin.
   */
  async checkForUpdate(
    pluginId: string,
    currentVersion: string,
    customRegistries: MarketplaceRegistry[] = [],
  ): Promise<MarketplacePlugin | null> {
    const { plugins, errors } = await this.fetchMarketplaces(customRegistries);
    if (errors.length > 0) {
      sidecarLog(`[MarketplaceService] Update check had ${errors.length} registry errors`);
    }

    const match = plugins.find((p) => p.id === pluginId);
    if (!match) return null;

    if (this.compareVersions(match.version, currentVersion) > 0) {
      return match;
    }
    return null;
  }
}

export const marketplaceService = new MarketplaceService();
