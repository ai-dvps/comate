import type { SlashCommandDto } from './initialization.js';

export interface CachedCommandList {
  commands: SlashCommandDto[];
  partial: boolean;
  partialReason?: string;
  /**
   * Output styles the CLI reports for this workspace (CLI 2.1.237+:
   * 'default', 'explanatory', 'learning', 'concise', plus any custom ones).
   * Absent when SDK discovery failed or the CLI predates the field.
   */
  outputStyles?: string[];
}

export type CommandSource = 'project' | 'skill' | 'plugin' | 'personal';
