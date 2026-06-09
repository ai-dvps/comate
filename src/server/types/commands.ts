import type { SlashCommandDto } from './initialization.js';

export interface CachedCommandList {
  commands: SlashCommandDto[];
  partial: boolean;
  partialReason?: string;
}

export type CommandSource = 'project' | 'skill' | 'plugin' | 'personal';
