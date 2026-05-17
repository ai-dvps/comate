export interface SlashCommandDto {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface InitializationResponse {
  commands: SlashCommandDto[];
}
