import type {
  ProviderCodexEffort,
  ProviderConfigurationV1,
  ProviderPresetProvenance,
} from '../models/provider.js';

export type ProviderVendorId = 'kimi' | 'bigmodel' | 'custom';

export interface ProviderPresetDefinition {
  id: ProviderVendorId;
  version: number;
  name: string;
  vendorId: ProviderVendorId;
  configuration: ProviderConfigurationV1;
  capabilities: {
    promptCacheRouting: 'auto' | 'unsupported';
    thinking: 'required' | 'supported' | 'unknown';
    /** UI value -> upstream Chat Completions value. */
    codexEffortWireMapping: Partial<Record<ProviderCodexEffort, string>>;
    thirdPartySpeed: false;
  };
}

const KIMI_MODEL = 'kimi-k2.5';

const PRESETS: readonly ProviderPresetDefinition[] = Object.freeze([
  {
    id: 'kimi',
    version: 1,
    name: 'Kimi For Coding',
    vendorId: 'kimi',
    configuration: {
      schemaVersion: 1,
      endpoints: {
        anthropic: { enabled: true, baseUrl: 'https://api.kimi.com/coding' },
        openai: {
          enabled: true,
          baseUrl: 'https://api.kimi.com/coding/v1',
          format: 'openai-chat-completions',
        },
      },
      models: { claudeCode: KIMI_MODEL, codex: KIMI_MODEL, openCode: KIMI_MODEL },
      openCode: { protocol: 'openai' },
      claude: {},
      codex: {
        promptCacheRouting: 'auto',
        thinking: 'required',
        effortByModel: { [KIMI_MODEL]: ['low', 'high', 'xhigh'] },
        effortWireMappingByModel: { [KIMI_MODEL]: { low: 'low', high: 'high', xhigh: 'max' } },
      },
      preset: { id: 'kimi', version: 1 },
    },
    capabilities: {
      promptCacheRouting: 'auto',
      thinking: 'required',
      codexEffortWireMapping: { low: 'low', high: 'high', xhigh: 'max' },
      thirdPartySpeed: false,
    },
  },
  {
    id: 'bigmodel',
    version: 1,
    name: 'BigModel Coding Plan',
    vendorId: 'bigmodel',
    configuration: {
      schemaVersion: 1,
      endpoints: {
        anthropic: { enabled: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
        openai: {
          enabled: true,
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          format: 'openai-chat-completions',
        },
      },
      models: {},
      openCode: { protocol: 'anthropic' },
      claude: {},
      codex: { promptCacheRouting: 'unsupported', thinking: 'supported' },
      preset: { id: 'bigmodel', version: 1 },
    },
    capabilities: {
      promptCacheRouting: 'unsupported',
      thinking: 'supported',
      codexEffortWireMapping: {},
      thirdPartySpeed: false,
    },
  },
  {
    id: 'custom',
    version: 1,
    name: 'Custom',
    vendorId: 'custom',
    configuration: {
      schemaVersion: 1,
      endpoints: {
        anthropic: { enabled: false, baseUrl: '' },
        openai: { enabled: false, baseUrl: '', format: 'openai-responses' },
      },
      models: {},
      openCode: { protocol: 'anthropic' },
      claude: {},
      codex: { promptCacheRouting: 'unsupported', thinking: 'unknown' },
      preset: { id: 'custom', version: 1 },
    },
    capabilities: {
      promptCacheRouting: 'unsupported',
      thinking: 'unknown',
      codexEffortWireMapping: {},
      thirdPartySpeed: false,
    },
  },
]);

export function listProviderPresets(): ProviderPresetDefinition[] {
  return PRESETS.map((preset) => structuredClone(preset));
}

export function getProviderPreset(id: string): ProviderPresetDefinition | undefined {
  const preset = PRESETS.find((entry) => entry.id === id);
  return preset ? structuredClone(preset) : undefined;
}

/** Returns ordinary, editable values. Only the diagnostic provenance remains linked. */
export function applyProviderPreset(id: string): ProviderConfigurationV1 | undefined {
  return getProviderPreset(id)?.configuration;
}

export function providerVendorFromProvenance(
  provenance?: ProviderPresetProvenance,
): ProviderVendorId | undefined {
  return provenance?.id === 'kimi' || provenance?.id === 'bigmodel' || provenance?.id === 'custom'
    ? provenance.id
    : undefined;
}
