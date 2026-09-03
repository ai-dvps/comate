import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession } from '../models/session.js';
import { botService } from './bot-service.js';
import { compileSkillFilter, compileSkillDenyRules } from './bot-skill-policy.js';
import { getBuiltinSkills } from './builtin-skills.js';

/** Use the same configured mounted/disabled set as the execution permission assembly. */
export function sessionSkillOptions(session?: ChatSession | null): Options {
  const bot = session?.botId ? botService.getBot(session.botId) : undefined;
  const policy = bot ? botService.getRolePolicy(bot.id) : undefined;
  const isolated = session?.source === 'wecom' || session?.source === 'feishu';
  const wecom = isolated && bot && botService.getChannelSettings(bot.id).wecom?.enabled;
  const builtin = getBuiltinSkills().filter(skill => {
    if (skill.name !== 'skill-manager') return wecom;
    if (!isolated) return true;
    return Boolean(policy && (!policy.skills || policy.skills.includes(skill.name)) && !policy.disabledSkills?.includes(skill.name));
  });
  return {
    env: { COMATE_BUILTIN_SKILLS: builtin.map(skill => skill.name).join(',') },
    ...(session?.source === 'wecom' || session?.source === 'feishu' ? { settingSources: [] } : {}),
    ...(isolated && policy?.skills ? { skills: compileSkillFilter(policy.skills) } : {}),
    ...(isolated && policy?.disabledSkills ? { settings: { permissions: { deny: compileSkillDenyRules(policy.disabledSkills) } } } : {}),
  };
}
