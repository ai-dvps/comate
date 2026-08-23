import type { Provider, ProviderCodexEffort, ProviderEndpoint, ProviderOpenAiEndpoint } from '../models/provider.js';
import type { BackendId } from './agent-backends.js';
import { providerVendorFromProvenance, type ProviderVendorId } from './provider-presets.js';

export type ProviderRouteMode =
  | 'direct-anthropic'
  | 'direct-openai-chat'
  | 'direct-openai-responses'
  | 'codex-chat-route';

export type ProviderUnavailableReason =
  | 'configuration-missing'
  | 'endpoint-missing'
  | 'endpoint-disabled'
  | 'endpoint-invalid'
  | 'model-missing'
  | 'credential-missing'
  | 'protocol-unsupported';

export interface ResolvedProviderBase {
  providerId: string;
  agent: BackendId;
  model: string;
  credential: string;
  baseUrl: string;
  vendorId?: ProviderVendorId;
  supportedEfforts: readonly ProviderCodexEffort[];
  speedSupported: false;
}

export type EffectiveProviderConfiguration =
  | (ResolvedProviderBase & { available: true; mode: ProviderRouteMode })
  | {
      available: false;
      providerId: string;
      agent: BackendId;
      mode: 'unavailable';
      reason: ProviderUnavailableReason;
      model?: string;
      vendorId?: ProviderVendorId;
      supportedEfforts: readonly ProviderCodexEffort[];
      speedSupported: false;
    };

export type PublicProviderAvailability = Omit<EffectiveProviderConfiguration, 'credential' | 'baseUrl'>;

type ResolutionSelection = {
  endpoint?: ProviderEndpoint | ProviderOpenAiEndpoint;
  model?: string;
  mode?: ProviderRouteMode;
  unsupported?: boolean;
};

function selectionFor(provider: Provider, agent: BackendId): ResolutionSelection {
  const config = provider.configuration;
  if (!config) return {};
  if (agent === 'claude') {
    return { endpoint: config.endpoints.anthropic, model: config.models.claudeCode, mode: 'direct-anthropic' };
  }
  if (agent === 'codex') {
    const endpoint = config.endpoints.openai;
    return {
      endpoint,
      model: config.models.codex,
      mode: endpoint?.format === 'openai-chat-completions' ? 'codex-chat-route' : 'direct-openai-responses',
    };
  }
  if (config.openCode.protocol === 'anthropic') {
    return { endpoint: config.endpoints.anthropic, model: config.models.openCode, mode: 'direct-anthropic' };
  }
  const endpoint = config.endpoints.openai;
  return {
    endpoint,
    model: config.models.openCode,
    mode: endpoint?.format === 'openai-chat-completions' ? 'direct-openai-chat' : 'direct-openai-responses',
    // OpenCode 1.18.4's custom OpenAI-compatible provider is proven against
    // Chat Completions.  Its Responses transport has not been characterized,
    // so fail closed instead of advertising a mode the adapter cannot select.
    unsupported: endpoint?.format === 'openai-responses',
  };
}

export function resolveProviderForAgent(provider: Provider, agent: BackendId): EffectiveProviderConfiguration {
  const config = provider.configuration;
  const vendorId = providerVendorFromProvenance(config?.preset);
  const unavailable = (reason: ProviderUnavailableReason, model?: string): EffectiveProviderConfiguration => ({
    available: false,
    providerId: provider.id,
    agent,
    mode: 'unavailable',
    reason,
    ...(model ? { model } : {}),
    ...(vendorId ? { vendorId } : {}),
    supportedEfforts: [],
    speedSupported: false,
  });
  if (!config) return unavailable('configuration-missing');
  const selected = selectionFor(provider, agent);
  if (selected.unsupported) return unavailable('protocol-unsupported', selected.model);
  if (!selected.endpoint) return unavailable('endpoint-missing', selected.model);
  if (!selected.endpoint.enabled) return unavailable('endpoint-disabled', selected.model);
  try {
    const url = new URL(selected.endpoint.baseUrl);
    if (url.protocol !== 'https:' || Boolean(url.username || url.password || url.hash)
        || (url.port !== '' && url.port !== '443') || !url.hostname || selected.endpoint.baseUrl.trim() === '') {
      return unavailable('endpoint-invalid', selected.model);
    }
  } catch {
    return unavailable('endpoint-invalid', selected.model);
  }
  if (!selected.model?.trim()) return unavailable('model-missing');
  if (!provider.authToken.trim()) return unavailable('credential-missing', selected.model);
  if (!selected.mode) return unavailable('protocol-unsupported', selected.model);
  const supportedEfforts = agent === 'codex'
    ? config.codex.effortByModel?.[selected.model] ?? []
    : [];
  return {
    available: true,
    providerId: provider.id,
    agent,
    mode: selected.mode,
    model: selected.model,
    credential: provider.authToken,
    baseUrl: selected.endpoint.baseUrl,
    ...(vendorId ? { vendorId } : {}),
    supportedEfforts,
    speedSupported: false,
  };
}

export function providerAvailability(provider: Provider): Record<BackendId, PublicProviderAvailability> {
  return {
    claude: redactResolvedProvider(resolveProviderForAgent(provider, 'claude')),
    codex: redactResolvedProvider(resolveProviderForAgent(provider, 'codex')),
    opencode: redactResolvedProvider(resolveProviderForAgent(provider, 'opencode')),
  };
}

export function redactResolvedProvider(resolved: EffectiveProviderConfiguration): PublicProviderAvailability {
  if (!resolved.available) return { ...resolved };
  return {
    available: true,
    providerId: resolved.providerId,
    agent: resolved.agent,
    mode: resolved.mode,
    model: resolved.model,
    ...(resolved.vendorId ? { vendorId: resolved.vendorId } : {}),
    supportedEfforts: resolved.supportedEfforts,
    speedSupported: false,
  };
}

/** Append a protocol resource while preserving versioned base paths and avoiding duplicate suffixes. */
export function providerResourceUrl(baseUrl: string, resource: 'models' | 'responses' | 'chat/completions'): string {
  return appendProviderResource(baseUrl, resource);
}

function appendProviderResource(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl);
  const baseSegments = url.pathname.split('/').filter(Boolean);
  const resourceSegments = resource.split('/');
  const overlapLimit = Math.min(baseSegments.length, resourceSegments.length);
  let overlap = 0;
  for (let size = overlapLimit; size > 0; size -= 1) {
    if (baseSegments.slice(-size).join('/') === resourceSegments.slice(0, size).join('/')) {
      overlap = size;
      break;
    }
  }
  url.pathname = `/${[...baseSegments, ...resourceSegments.slice(overlap)].join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function effectiveProviderResourceUrl(
  resolved: Extract<EffectiveProviderConfiguration, { available: true }>,
  resource: 'models' | 'responses' | 'chat/completions',
): string {
  return appendProviderResource(
    resolved.baseUrl,
    resolved.mode === 'direct-anthropic' && resource === 'models' ? 'v1/models' : resource,
  );
}
