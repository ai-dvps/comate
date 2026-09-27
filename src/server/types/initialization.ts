export interface SlashCommandDto {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface InitializationResponse {
  commands: SlashCommandDto[];
  /**
   * CLI 2.1.237+ (system/init frame): slash commands whose UX is bound to the
   * local terminal (exit, statusline, …). Hosts with their own UI should hide
   * them from command menus; already filtered out of `commands`.
   */
  terminalSlashCommands?: string[];
  /** CLI initialize response: active output style (e.g. 'default', 'concise'). */
  outputStyle?: string;
  /** CLI initialize response: every output style available in this workspace. */
  availableOutputStyles?: string[];
}
