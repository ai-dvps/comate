import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
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
  sourceType?: 'git' | 'zip' | 'local';
  builtIn?: boolean;
}

export interface MarketplaceRegistry {
  name: string;
  url?: string;
  githubRepo?: string;
  localPath?: string;
  builtIn?: boolean;
}

export interface BuiltInMarketplace {
  name: string;
  localPath: string;
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
  private builtInRegistries: MarketplaceRegistry[] = [];

  /**
   * Register a built-in marketplace that cannot be removed by users.
   */
  registerBuiltInMarketplace(registry: Omit<MarketplaceRegistry, 'builtIn'>): void {
    this.builtInRegistries.push({ ...registry, builtIn: true });
  }

  /**
   * Return the list of registered built-in marketplaces.
   */
  getBuiltInMarketplaces(): MarketplaceRegistry[] {
    return [...this.builtInRegistries];
  }

  /**
   * Fetch plugins from a single registry.
   */
  private async fetchRegistryPlugins(registry: MarketplaceRegistry): Promise<MarketplacePlugin[]> {
    if (registry.localPath) {
      return this.fetchLocalMarketplace(registry.localPath, registry.name, registry.builtIn);
    }
    if (registry.githubRepo) {
      return this.fetchGitHubMarketplace(registry.githubRepo, registry.name, registry.builtIn);
    }
    if (registry.url) {
      return this.fetchRegistry(registry);
    }
    throw new Error('Marketplace registry has no url, githubRepo, or localPath');
  }

  /**
   * Fetch plugins from all configured marketplaces.
   */
  async fetchMarketplaces(
    customRegistries: MarketplaceRegistry[] = [],
    query?: string,
  ): Promise<MarketplaceFetchResult> {
    const registries = [...this.defaultRegistries, ...this.builtInRegistries, ...customRegistries];
    const allPlugins: MarketplacePlugin[] = [];
    const errors: { marketplace: string; error: string }[] = [];

    await Promise.all(
      registries.map(async (registry) => {
        try {
          const plugins = await this.fetchRegistryPlugins(registry);
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
   * Fetch plugins from registered built-in marketplaces only.
   */
  async fetchBuiltInMarketplaces(query?: string): Promise<MarketplaceFetchResult> {
    const allPlugins: MarketplacePlugin[] = [];
    const errors: { marketplace: string; error: string }[] = [];

    await Promise.all(
      this.builtInRegistries.map(async (registry) => {
        try {
          const plugins = await this.fetchRegistryPlugins(registry);
          allPlugins.push(...plugins);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sidecarLog(`[MarketplaceService] Failed to fetch built-in ${registry.name}: ${message}`);
          errors.push({ marketplace: registry.name, error: message });
        }
      }),
    );

    const deduped = this.deduplicatePlugins(allPlugins);
    const filtered = query ? this.filterPlugins(deduped, query) : deduped;
    return { plugins: filtered, errors };
  }

  /**
   * Load cached marketplaces from disk and always merge built-in marketplaces.
   * Falls back to network/custom registries when no cached marketplaces exist.
   */
  async fetchAllMarketplaces(
    customRegistries: MarketplaceRegistry[] = [],
    query?: string,
  ): Promise<MarketplaceFetchResult> {
    const cached = this.loadCachedMarketplaces();

    // No cache on disk: use the live fetch path (default + built-in + custom registries).
    if (cached.plugins.length === 0 && cached.errors.length === 0) {
      return this.fetchMarketplaces(customRegistries, query);
    }

    // Cache present: merge built-in marketplaces so they are always visible.
    const builtIn = await this.fetchBuiltInMarketplaces();
    const merged = this.deduplicatePlugins([...cached.plugins, ...builtIn.plugins]);
    const filtered = query ? this.filterPlugins(merged, query) : merged;

    return { plugins: filtered, errors: [...cached.errors, ...builtIn.errors] };
  }

  /**
   * Fetch a single JSON registry.
   */
  private async fetchRegistry(registry: MarketplaceRegistry): Promise<MarketplacePlugin[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(registry.url!, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as unknown;
    const plugins = this.parseRegistryResponse(data, registry.name, registry.builtIn);
    sidecarLog(`[MarketplaceService] Fetched ${plugins.length} plugins from ${registry.name}`);
    return plugins;
  }

  /**
   * Fetch a GitHub repo-based marketplace by reading .claude-plugin/marketplace.json
   */
  private async fetchGitHubMarketplace(
    repo: string,
    marketplaceName: string,
    builtIn?: boolean,
  ): Promise<MarketplacePlugin[]> {
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
        const plugins = this.parseMarketplaceJson(data, repo, marketplaceName, 'github', builtIn);
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
   * Fetch a local-directory marketplace by reading .claude-plugin/marketplace.json
   */
  private async fetchLocalMarketplace(
    localPath: string,
    marketplaceName: string,
    builtIn?: boolean,
  ): Promise<MarketplacePlugin[]> {
    const marketplaceFile = join(localPath, '.claude-plugin', 'marketplace.json');
    if (!existsSync(marketplaceFile)) {
      throw new Error(`marketplace.json not found at ${marketplaceFile}`);
    }

    const content = readFileSync(marketplaceFile, 'utf-8');
    const data = JSON.parse(content) as unknown;
    const plugins = this.parseMarketplaceJson(data, localPath, marketplaceName, 'local', builtIn);
    sidecarLog(`[MarketplaceService] Fetched ${plugins.length} plugins from local marketplace ${marketplaceName}`);
    return plugins;
  }

  /**
   * Parse a Claude Code marketplace.json file.
   */
  private parseMarketplaceJson(
    data: unknown,
    source: string,
    marketplaceName: string,
    sourceKind: 'github' | 'local' = 'github',
    builtIn?: boolean,
  ): MarketplacePlugin[] {
    if (!data || typeof data !== 'object') return [];
    const mp = data as ClaudeMarketplaceJson;
    const items = Array.isArray(mp.plugins) ? mp.plugins : [];

    return items
      .map((item) => this.normalizeMarketplaceEntry(item, source, marketplaceName, sourceKind, builtIn))
      .filter((p): p is MarketplacePlugin => p !== null);
  }

  private normalizeMarketplaceEntry(
    item: ClaudeMarketplacePluginEntry,
    source: string,
    marketplaceName: string,
    sourceKind: 'github' | 'local' = 'github',
    builtIn?: boolean,
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

    // Construct sourceUrl from repo + relative source path, or local absolute path
    let sourceUrl: string | undefined;
    const sourceType: MarketplacePlugin['sourceType'] = sourceKind === 'local' ? 'local' : 'git';
    if (sourceKind === 'local') {
      if (typeof item.source === 'string' && item.source.startsWith('./')) {
        sourceUrl = resolve(source, item.source);
      } else if (typeof item.source === 'string') {
        sourceUrl = resolve(source, item.source);
      } else if (typeof item.homepage === 'string') {
        sourceUrl = item.homepage;
      }
    } else if (typeof item.source === 'string') {
      // source is like "./plugins/compound-engineering" — point to the full repo for cloning
      sourceUrl = `https://github.com/${source}.git`;
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
      sourceType,
      builtIn,
    };
  }

  /**
   * Parse registry response. Accepts both array and { plugins: [...] } shapes.
   */
  private parseRegistryResponse(data: unknown, marketplaceName: string, builtIn?: boolean): MarketplacePlugin[] {
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
      .map((item) => this.normalizePluginEntry(item, marketplaceName, builtIn))
      .filter((p): p is MarketplacePlugin => p !== null);
  }

  private normalizePluginEntry(item: unknown, marketplaceName: string, builtIn?: boolean): MarketplacePlugin | null {
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
      sourceType: obj.sourceType === 'git' || obj.sourceType === 'zip' || obj.sourceType === 'local' ? obj.sourceType : undefined,
      builtIn,
    };
  }

  deduplicatePlugins(plugins: MarketplacePlugin[]): MarketplacePlugin[] {
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
