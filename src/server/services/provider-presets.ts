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
const BIGMODEL_MODEL = 'glm-5.3';

const PRESETS: readonly ProviderPresetDefinition[] = [
  {
    id: 'kimi',
    version: 2,
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
        modelProfiles: {
          [KIMI_MODEL]: {
            promptCacheRouting: 'auto',
            thinking: 'required',
            supportedEfforts: ['low', 'high', 'xhigh'],
            effortWireMapping: { low: 'low', high: 'high', xhigh: 'max' },
          },
        },
      },
      preset: { id: 'kimi', version: 2 },
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
    version: 2,
    name: 'BigModel Coding Plan',
    vendorId: 'bigmodel',
    configuration: {
      schemaVersion: 1,
      endpoints: {
        anthropic: { enabled: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
        openai: {
          enabled: true,
          baseUrl: 'https://open.bigmodel.cn/api/v1',
          format: 'openai-responses',
        },
      },
      models: { claudeCode: BIGMODEL_MODEL, codex: BIGMODEL_MODEL, openCode: BIGMODEL_MODEL },
      openCode: {
        protocol: 'anthropic',
        modelProfiles: {
          [BIGMODEL_MODEL]: {
            contextWindow: 1_048_576,
            reasoning: true,
            toolCall: true,
            inputModalities: ['text'],
            outputModalities: ['text'],
          },
        },
      },
      claude: {},
      codex: {
        modelProfiles: {
          [BIGMODEL_MODEL]: {
            contextWindow: 1_048_576,
            promptCacheRouting: 'unsupported',
            thinking: 'supported',
            supportedEfforts: ['low', 'high', 'xhigh'],
            effortWireMapping: { low: 'low', high: 'high', xhigh: 'max' },
            reasoningSummary: 'none',
            supportsReasoningSummaries: true,
          },
        },
      },
      preset: { id: 'bigmodel', version: 2 },
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
      codex: {},
      preset: { id: 'custom', version: 1 },
    },
    capabilities: {
      promptCacheRouting: 'unsupported',
      thinking: 'unknown',
      codexEffortWireMapping: {},
      thirdPartySpeed: false,
    },
  },
];

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
