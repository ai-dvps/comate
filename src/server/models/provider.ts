export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  authToken: string;
  model?: string;
  isDefault: boolean;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
  supportsFastMode?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderInput {
  name: string;
  baseUrl: string;
  authToken: string;
  model?: string;
  isDefault?: boolean;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
  skipHealthCheck?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  authToken?: string;
  model?: string;
  isDefault?: boolean;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  subagentModel?: string;
  effortLevel?: string;
  customEnvVars?: Record<string, string>;
  skipHealthCheck?: boolean;
}
