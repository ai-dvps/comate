import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Loader2, Shield, UserCog, User, AlertTriangle } from 'lucide-react';
import type { Bot, BotRole, BotRolePolicy } from '../stores/bot-store';
import { PermissionsSubTab } from './PermissionsSubTab';
import { SAFE_PRESET, type ToolPermissionPolicy } from '../types/wecom-permissions';
import { cn } from './ui/utils';

interface BotRolePermissionsProps {
  bot: Bot;
  isSaving?: boolean;
  error?: string | null;
  onSave: (rolePolicy: BotRolePolicy) => void | Promise<void>;
  onBack?: () => void;
}

const ROLE_ORDER: BotRole[] = ['owner', 'admin', 'normal'];

function normalizeToolPolicy(value: unknown): ToolPermissionPolicy {
  if (
    value &&
    typeof value === 'object' &&
    'posture' in value &&
    'categoryDefaults' in value
  ) {
    return value as ToolPermissionPolicy;
  }
  return SAFE_PRESET;
}

function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function BotRolePermissions({
  bot,
  isSaving,
  error,
  onSave,
  onBack,
}: BotRolePermissionsProps) {
  const { t } = useTranslation('settings');
  const [selectedRole, setSelectedRole] = useState<BotRole>('normal');
  const [normalToolPolicy, setNormalToolPolicy] = useState<ToolPermissionPolicy>(SAFE_PRESET);
  const [skillAllowlist, setSkillAllowlist] = useState('');
  const [bashWhitelist, setBashWhitelist] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const policy = bot.rolePolicy?.normalToolPolicy;
    setNormalToolPolicy(normalizeToolPolicy(policy));
    setSkillAllowlist((bot.rolePolicy?.skillAllowlist ?? []).join('\n'));
    setBashWhitelist((bot.rolePolicy?.bashWhitelist ?? []).join('\n'));
    setSaveError(null);
  }, [bot]);

  const handleSave = async () => {
    setSaveError(null);
    const rolePolicy: BotRolePolicy = {
      normalToolPolicy: normalToolPolicy as unknown as Record<string, unknown>,
      skillAllowlist: parseLines(skillAllowlist),
      bashWhitelist: parseLines(bashWhitelist),
    };
    try {
      await onSave(rolePolicy);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const roleIcons: Record<BotRole, React.ReactNode> = {
    owner: <Shield className="w-3.5 h-3.5" />,
    admin: <UserCog className="w-3.5 h-3.5" />,
    normal: <User className="w-3.5 h-3.5" />,
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-text-secondary hover:text-text-primary text-xs"
            >
              ← {t('bots.backToList')}
            </button>
          )}
          <h4 className="text-xs font-medium text-text-secondary">{t('bots.roles.title')}</h4>
        </div>
      </div>

      <p className="text-[10px] text-text-tertiary">{t('bots.roles.description')}</p>

      {(error || saveError) && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{saveError || error}</p>
        </div>
      )}

      <div className="flex gap-1 p-1 bg-surface-hover rounded-lg">
        {ROLE_ORDER.map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => setSelectedRole(role)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] font-medium rounded transition-colors',
              selectedRole === role
                ? 'bg-surface-active text-text-primary'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {roleIcons[role]}
            {t(`bots.role${role.charAt(0).toUpperCase() + role.slice(1)}`)}
          </button>
        ))}
      </div>

      {selectedRole !== 'normal' && (
        <div className="p-3 bg-surface-hover/50 border border-border rounded-lg">
          <p className="text-xs text-text-secondary">
            {t(selectedRole === 'owner' ? 'bots.roles.ownerDescription' : 'bots.roles.adminDescription')}
          </p>
        </div>
      )}

      {selectedRole === 'normal' && (
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-text-tertiary mb-2">
              {t('bots.rolePermissions.toolPolicy')}
            </label>
            <PermissionsSubTab
              policy={normalToolPolicy}
              onUpdate={(next) => setNormalToolPolicy(next)}
              workspaceId={bot.id}
              needsUpgradePrompt={false}
              onApplySafePreset={async () => setNormalToolPolicy(SAFE_PRESET)}
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-text-tertiary mb-1">
              {t('bots.rolePermissions.skillAllowlist')}
            </label>
            <textarea
              value={skillAllowlist}
              onChange={(e) => setSkillAllowlist(e.target.value)}
              placeholder={t('bots.rolePermissions.skillAllowlistPlaceholder')}
              rows={3}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('bots.rolePermissions.skillAllowlistHint')}
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-text-tertiary mb-1">
              {t('bots.rolePermissions.bashWhitelist')}
            </label>
            <textarea
              value={bashWhitelist}
              onChange={(e) => setBashWhitelist(e.target.value)}
              placeholder={t('bots.rolePermissions.bashWhitelistPlaceholder')}
              rows={3}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('bots.rolePermissions.bashWhitelistHint')}
            </p>
          </div>

          <div className="flex items-center justify-end pt-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('actions.saving')}
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  {t('actions.save')}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
