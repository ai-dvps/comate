import type { BotChannelSettings, BotRolePolicy, CreateBotInput } from '../models/bot.js';
import type { Workspace } from '../models/workspace.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { ALLOW_ALL_PRESET } from './tool-permission-policy.js';
import { BuiltinPluginService, builtinPluginService as defaultBuiltinPluginService } from './builtin-plugin-service.js';

export interface MigrationResult {
  success: boolean;
  dryRun: boolean;
  createdBots: number;
  migratedWorkspaces: number;
  skippedWorkspaces: number;
  errors: string[];
  preview?: Array<{
    workspaceId: string;
    workspaceName: string;
    botName: string;
    channels: string[];
    members: Array<{ channel: 'wecom' | 'feishu'; channelUserId: string; role: 'admin' | 'normal' }>;
  }>;
}

interface MigrationItem {
  workspace: Workspace;
  botName: string;
  channelSettings: BotChannelSettings;
  rolePolicy: BotRolePolicy;
  adminUserIds: Map<'wecom' | 'feishu', Set<string>>;
  normalUserIds: Map<'wecom' | 'feishu', Set<string>>;
}

export class BotMigrationService {
  private store: SqliteStore;
  private builtinPluginService: BuiltinPluginService;

  constructor(store: SqliteStore, builtinPluginService?: BuiltinPluginService) {
    this.store = store;
    this.builtinPluginService = builtinPluginService ?? defaultBuiltinPluginService;
  }

  hasMigrationRun(): boolean {
    return this.store.getMigrationVersion() !== null;
  }

  async migrate(options: { dryRun?: boolean } = {}): Promise<MigrationResult> {
    const dryRun = options.dryRun ?? false;
    const result: MigrationResult = {
      success: false,
      dryRun,
      createdBots: 0,
      migratedWorkspaces: 0,
      skippedWorkspaces: 0,
      errors: [],
    };

    if (!dryRun && this.hasMigrationRun()) {
      const bots = this.store.listBots();
      result.success = true;
      result.createdBots = bots.length;
      result.migratedWorkspaces = bots.length;
      return result;
    }

    let workspaces: Workspace[];
    try {
      workspaces = await this.store.list();
    } catch (err) {
      result.errors.push(`Failed to list workspaces: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    const items: MigrationItem[] = [];
    for (const workspace of workspaces) {
      const item = this.buildMigrationItem(workspace);
      if (item) {
        items.push(item);
      } else {
        result.skippedWorkspaces += 1;
      }
    }

    const snapshot: Record<string, string> = {};
    for (const workspace of workspaces) {
      snapshot[workspace.id] = JSON.stringify(workspace.settings);
    }

    if (dryRun) {
      result.success = true;
      result.preview = items.map((item) => ({
        workspaceId: item.workspace.id,
        workspaceName: item.workspace.name,
        botName: item.botName,
        channels: Object.keys(item.channelSettings),
        members: this.flattenMembers(item.adminUserIds, item.normalUserIds),
      }));
      result.createdBots = items.length;
      result.migratedWorkspaces = items.length;
      return result;
    }

    try {
      this.store.runInTransaction(() => {
        for (const item of items) {
          this.migrateWorkspace(item);
        }
        this.store.setMigrationState(1, new Date().toISOString(), snapshot);
      });
    } catch (err) {
      result.errors.push(`Migration failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    result.success = true;
    result.createdBots = items.length;
    result.migratedWorkspaces = items.length;

    // Backfill the built-in wecom plugin for any migrated workspace that has
    // WeCom enabled. This is best-effort and must not fail the migration.
    for (const item of items) {
      if (item.channelSettings.wecom) {
        await this.builtinPluginService.ensureWecomPluginInstalled(item.workspace.id).catch((err) => {
          console.error(`[BotMigration] failed to install wecom plugin for ${item.workspace.id}:`, err);
        });
      }
    }

    return result;
  }

  private migrateWorkspace(item: MigrationItem): void {
    const input: CreateBotInput = {
      name: item.botName,
      activeWorkspaceId: item.workspace.id,
    };

    const bot = this.store.createBot(input);

    // Update existing channels created by createBot
    for (const channelKey of Object.keys(item.channelSettings) as Array<keyof typeof item.channelSettings>) {
      const config = item.channelSettings[channelKey];
      if (config) {
        const channel = this.store.getBotChannelByKey(bot.id, channelKey);
        if (channel) {
          this.store.updateBotChannel(channel.id, { [channelKey]: config });
        }
      }
    }

    // Update the normal role permissions
    const normalRole = this.store.getBotRoleByKey(bot.id, 'normal');
    if (normalRole) {
      this.store.updateBotRole(normalRole.id, item.rolePolicy);
    }

    for (const [channel, userIds] of item.adminUserIds) {
      const channelObj = this.store.getBotChannelByKey(bot.id, channel);
      const roleObj = this.store.getBotRoleByKey(bot.id, 'admin');
      if (!channelObj || !roleObj) continue;
      for (const userId of userIds) {
        this.store.createBotUser({ botId: bot.id, channelId: channelObj.id, channelUserId: userId, roleId: roleObj.id });
      }
    }

    for (const [channel, userIds] of item.normalUserIds) {
      const channelObj = this.store.getBotChannelByKey(bot.id, channel);
      const roleObj = this.store.getBotRoleByKey(bot.id, 'normal');
      if (!channelObj || !roleObj) continue;
      for (const userId of userIds) {
        this.store.createBotUser({ botId: bot.id, channelId: channelObj.id, channelUserId: userId, roleId: roleObj.id });
      }
    }

    const sessions = this.store.listLocalSessions(item.workspace.id);
    for (const session of sessions) {
      this.store.setSessionBotId(session.id, bot.id);
    }

    const cleanedSettings = this.cleanWorkspaceSettings(item.workspace.settings);
    this.store.update(item.workspace.id, { settings: cleanedSettings });
  }

  private buildMigrationItem(workspace: Workspace): MigrationItem | null {
    const wecom = this.extractWecomConfig(workspace);
    const feishu = this.extractFeishuConfig(workspace);
    if (!wecom && !feishu) {
      return null;
    }

    const channelSettings: BotChannelSettings = {};
    if (wecom) channelSettings.wecom = wecom;
    if (feishu) channelSettings.feishu = feishu;

    const isolation = workspace.settings.wecomBotIsolation;
    const wecomAdmins = new Set(isolation?.adminUserIds ?? []);
    const feishuAdmins = new Set(workspace.settings.feishuAdminUserIds ?? []);

    const adminUserIds = new Map<'wecom' | 'feishu', Set<string>>();
    const normalUserIds = new Map<'wecom' | 'feishu', Set<string>>();

    if (wecom) {
      adminUserIds.set('wecom', new Set(wecomAdmins));
      normalUserIds.set('wecom', new Set());
      for (const row of this.store.listWecomWorkspaceUsers(workspace.id)) {
        const channelUserId = this.store.getWecomUserMapping(row.encryptedUserId) ?? row.encryptedUserId;
        if (wecomAdmins.has(channelUserId)) continue;
        normalUserIds.get('wecom')!.add(channelUserId);
      }
    }

    if (feishu) {
      adminUserIds.set('feishu', new Set(feishuAdmins));
      normalUserIds.set('feishu', new Set());
      for (const row of this.store.listFeishuWorkspaceUsers(workspace.id)) {
        if (feishuAdmins.has(row.openId)) continue;
        normalUserIds.get('feishu')!.add(row.openId);
      }
    }

    const rolePolicy: BotRolePolicy = {
      normalToolPolicy: workspace.settings.wecomToolPermissions ?? ALLOW_ALL_PRESET,
      skillAllowlist: [
        ...(isolation?.defaultAllowedSkills ?? []),
        ...(isolation?.adminAllowedSkills ?? []),
      ],
      bashWhitelist: [],
    };

    const botName =
      workspace.settings.wecomBotName ||
      workspace.settings.feishuBotName ||
      workspace.name;

    return {
      workspace,
      botName,
      channelSettings,
      rolePolicy,
      adminUserIds,
      normalUserIds,
    };
  }

  private extractWecomConfig(workspace: Workspace) {
    const settings = workspace.settings;
    if (!settings.wecomBotEnabled || !settings.wecomBotId || !settings.wecomBotSecret) {
      return undefined;
    }
    return {
      enabled: true,
      botId: settings.wecomBotId,
      botSecret: settings.wecomBotSecret,
      botName: settings.wecomBotName,
      corpId: settings.wecomCorpId,
      corpSecret: settings.wecomCorpSecret,
    };
  }

  private extractFeishuConfig(workspace: Workspace) {
    const settings = workspace.settings;
    if (!settings.feishuBotEnabled || !settings.feishuAppId || !settings.feishuAppSecret) {
      return undefined;
    }
    return {
      enabled: true,
      appId: settings.feishuAppId,
      appSecret: settings.feishuAppSecret,
      encryptKey: settings.feishuEncryptKey,
      verificationToken: settings.feishuVerificationToken,
      botName: settings.feishuBotName,
    };
  }

  private cleanWorkspaceSettings(settings: Workspace['settings']): Workspace['settings'] {
    const cleanedSettings: Workspace['settings'] = {
      ...settings,
      sensitiveFileDenylist: settings.sensitiveFileDenylist ?? [],
    };
    const botFields = [
      'wecomBotId',
      'wecomBotSecret',
      'wecomBotEnabled',
      'wecomBotName',
      'wecomCorpId',
      'wecomCorpSecret',
      'wecomToolPermissions',
      'wecomBotIsolation',
      'feishuAppId',
      'feishuAppSecret',
      'feishuEncryptKey',
      'feishuVerificationToken',
      'feishuBotEnabled',
      'feishuBotName',
      'feishuAdminUserIds',
    ];
    for (const field of botFields) {
      delete (cleanedSettings as Record<string, unknown>)[field];
    }
    return cleanedSettings;
  }

  private flattenMembers(
    adminUserIds: Map<'wecom' | 'feishu', Set<string>>,
    normalUserIds: Map<'wecom' | 'feishu', Set<string>>,
  ): Array<{ channel: 'wecom' | 'feishu'; channelUserId: string; role: 'admin' | 'normal' }> {
    const members: Array<{ channel: 'wecom' | 'feishu'; channelUserId: string; role: 'admin' | 'normal' }> = [];
    for (const [channel, userIds] of adminUserIds) {
      for (const userId of userIds) {
        members.push({ channel, channelUserId: userId, role: 'admin' });
      }
    }
    for (const [channel, userIds] of normalUserIds) {
      for (const userId of userIds) {
        members.push({ channel, channelUserId: userId, role: 'normal' });
      }
    }
    return members;
  }
}
