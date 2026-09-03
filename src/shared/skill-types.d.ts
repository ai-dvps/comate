export interface SkillInstallation {
  id: string;
  name: string;
  description: string;
  scope: 'project' | 'global' | 'builtin';
  source: string;
  installPath: string;
  realPath: string;
  aliases: string[];
  backends: Array<'claude' | 'codex' | 'opencode'>;
  isLegacySymlink: boolean;
  kind: 'skill' | 'expert-package-orchestrator';
  packageSlug?: string;
  invocationName: string;
}
