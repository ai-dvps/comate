import {
  useState,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, UserCog, User, AlertTriangle, Plus, X } from 'lucide-react';
import type { Bot, BotRole, BotRolePolicy, PasslistRule } from '../stores/bot-store';
import { PermissionsSubTab } from './PermissionsSubTab';
import { SAFE_PRESET, type ToolPermissionPolicy } from '../types/wecom-permissions';
import { useBotPasslistUpgradeBanner } from '../hooks/use-bot-passlist-upgrade-banner';
import { cn } from './ui/utils';

export interface BotRolePermissionsHandle {
  isDirty: () => boolean;
  save: () => Promise<void>;
  discard: () => void;
}

interface BotRolePermissionsProps {
  bot: Bot;
  error?: string | null;
  onSave: (rolePolicy: BotRolePolicy) => void | Promise<void>;
  onBack?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
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

function normalizePasslistRules(value: unknown): PasslistRule[] {
  if (!Array.isArray(value)) return [];
  const out: PasslistRule[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      out.push({ rule: entry });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof (entry as PasslistRule).rule === 'string') {
      const rule = (entry as PasslistRule).rule;
      if (rule.trim() === '') continue;
      const provenance = (entry as PasslistRule).provenance;
      out.push(
        provenance &&
          typeof provenance.addedBy === 'string' &&
          (provenance.source === 'manual' || provenance.source === 'approval') &&
          typeof provenance.createdAt === 'string'
          ? { rule, provenance }
          : { rule },
      );
    }
  }
  return out;
}

/**
 * Composite-command detector (KTD-18): the passlist holds single literal
 * subcommands because the SDK rule engine evaluates compound commands
 * per-subcommand — a passlist entry must never itself be a composition.
 */
const COMPOSITE_PATTERN = /\|\||&&|[;|`]|\$\(/;

type MatchSemantics = 'exact' | 'prefix';

/** Wrap a validated single command into an SDK structural rule (KTD-13). */
function compilePasslistRule(command: string, semantics: MatchSemantics): string {
  return semantics === 'exact' ? `Bash(${command})` : `Bash(${command} *)`;
}

/** Provenance stamped on GUI additions. */
function manualProvenance(): NonNullable<PasslistRule['provenance']> {
  return { addedBy: 'desktop-admin', source: 'manual', createdAt: new Date().toISOString() };
}

interface SavedRolePolicy {
  normalToolPolicy: ToolPermissionPolicy;
  passlistRules: PasslistRule[];
}

const BotRolePermissions = forwardRef<BotRolePermissionsHandle, BotRolePermissionsProps>(
  function BotRolePermissions(
    { bot, error, onSave, onBack, onDirtyChange },
    ref,
  ) {
    const { t } = useTranslation('settings');
    const [selectedRole, setSelectedRole] = useState<BotRole>('normal');
    const [normalToolPolicy, setNormalToolPolicy] = useState<ToolPermissionPolicy>(SAFE_PRESET);
    const [passlistRules, setPasslistRules] = useState<PasslistRule[]>([]);
    const [saved, setSaved] = useState<SavedRolePolicy>({
      normalToolPolicy: SAFE_PRESET,
      passlistRules: [],
    });
    const [saveError, setSaveError] = useState<string | null>(null);

    // Add-form state
    const [newCommand, setNewCommand] = useState('');
    const [newSemantics, setNewSemantics] = useState<MatchSemantics>('exact');
    const [duplicateRejected, setDuplicateRejected] = useState(false);

    const hasLegacyData =
      (bot.rolePolicy?.skillAllowlist?.length ?? 0) > 0 ||
      (bot.rolePolicy?.bashWhitelist?.length ?? 0) > 0;
    const { shouldShow: showUpgradeBanner, dismiss: dismissUpgradeBanner } =
      useBotPasslistUpgradeBanner({ botId: bot.id, hasLegacyData: hasLegacyData });

    const lastBotIdRef = useRef<string | null>(null);

    useEffect(() => {
      // Only reset local editor state when the selected bot changes. Re-renders
      // caused by saving another slice (Basic/Persona) should not wipe dirty
      // role-permission edits.
      if (lastBotIdRef.current === bot.id) return;
      lastBotIdRef.current = bot.id;
      const policy = normalizeToolPolicy(bot.rolePolicy?.normalToolPolicy);
      const rules = normalizePasslistRules(bot.rolePolicy?.passlistRules);
      setNormalToolPolicy(policy);
      setPasslistRules(rules);
      setSaved({ normalToolPolicy: policy, passlistRules: rules });
      setSaveError(null);
      setNewCommand('');
      setNewSemantics('exact');
      setDuplicateRejected(false);
    }, [bot]);

    const isDirty = useMemo(() => {
      return (
        JSON.stringify(normalToolPolicy) !== JSON.stringify(saved.normalToolPolicy) ||
        JSON.stringify(passlistRules) !== JSON.stringify(saved.passlistRules)
      );
    }, [normalToolPolicy, passlistRules, saved]);

    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;

    useEffect(() => {
      onDirtyChangeRef.current?.(isDirty);
    }, [isDirty]);

    useImperativeHandle(
      ref,
      () => ({
        isDirty: () => isDirty,
        save: async () => {
          setSaveError(null);
          // Round-trip fields this editor does not own (U5 skill config,
          // network allowlist) so a role-permission save never wipes them.
          // The deprecated legacy whitelist fields are deliberately cleared:
          // saving adopts the new model and retires the upgrade banner.
          const rolePolicy: BotRolePolicy = {
            normalToolPolicy: normalToolPolicy as unknown as Record<string, unknown>,
            skillAllowlist: [],
            bashWhitelist: [],
            ...(bot.rolePolicy?.skills !== undefined ? { skills: bot.rolePolicy.skills } : {}),
            disabledSkills: bot.rolePolicy?.disabledSkills ?? [],
            passlistRules,
            networkAllowlist: bot.rolePolicy?.networkAllowlist ?? [],
          };
          try {
            await onSave(rolePolicy);
            setSaved({ normalToolPolicy, passlistRules });
          } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
            throw err;
          }
        },
        discard: () => {
          setNormalToolPolicy(saved.normalToolPolicy);
          setPasslistRules(saved.passlistRules);
          setSaveError(null);
          setNewCommand('');
          setNewSemantics('exact');
          setDuplicateRejected(false);
        },
      }),
      [isDirty, normalToolPolicy, passlistRules, saved, onSave, bot.rolePolicy],
    );

    const trimmedCommand = newCommand.trim();
    const compositeDetected = COMPOSITE_PATTERN.test(trimmedCommand);
    const candidateRule = trimmedCommand !== '' && !compositeDetected
      ? compilePasslistRule(trimmedCommand, newSemantics)
      : null;
    const duplicateRule = candidateRule !== null && passlistRules.some((entry) => entry.rule === candidateRule);

    const handleAddRule = () => {
      setDuplicateRejected(false);
      if (trimmedCommand === '' || compositeDetected || !candidateRule) return;
      if (duplicateRule) {
        setDuplicateRejected(true);
        return;
      }
      setPasslistRules((prev) => [...prev, { rule: candidateRule, provenance: manualProvenance() }]);
      setNewCommand('');
      setNewSemantics('exact');
    };

    const handleRemoveRule = (index: number) => {
      setPasslistRules((prev) => prev.filter((_, i) => i !== index));
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

        {showUpgradeBanner && (
          <div className="border border-yellow-500/40 bg-yellow-500/10 rounded p-3 space-y-2" role="status">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-text-primary">
                  {t('bots.rolePermissions.upgradeBanner.title')}
                </div>
                <div className="text-[11px] text-text-secondary mt-1">
                  {t('bots.rolePermissions.upgradeBanner.body')}
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={dismissUpgradeBanner}
                    className="px-3 py-1 text-[11px] font-medium text-text-secondary hover:text-text-primary"
                  >
                    {t('bots.rolePermissions.upgradeBanner.dismiss')}
                  </button>
                </div>
              </div>
            </div>
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
                {t('bots.rolePermissions.passlist')}
              </label>
              <p className="text-[10px] text-text-tertiary mb-2">
                {t('bots.rolePermissions.passlistHint')}
              </p>

              {passlistRules.length === 0 ? (
                <p className="text-[11px] text-text-secondary border border-dashed border-border rounded-lg px-3 py-2">
                  {t('bots.rolePermissions.passlistEmpty')}
                </p>
              ) : (
                <ul className="space-y-1.5 mb-2">
                  {passlistRules.map((entry, index) => (
                    <li
                      key={`${entry.rule}-${index}`}
                      className="flex items-start justify-between gap-2 border border-border rounded-lg px-3 py-2"
                    >
                      <div className="min-w-0">
                        <code className="block text-[12px] font-mono text-text-primary break-all">
                          {entry.rule}
                        </code>
                        <span className="block text-[10px] text-text-tertiary mt-0.5">
                          {entry.provenance
                            ? t(
                                entry.provenance.source === 'approval'
                                  ? 'bots.rolePermissions.passlistProvenanceApproval'
                                  : 'bots.rolePermissions.passlistProvenanceManual',
                                {
                                  actor: entry.provenance.addedBy,
                                  date: entry.provenance.createdAt.slice(0, 10),
                                },
                              )
                            : t('bots.rolePermissions.passlistProvenanceUnknown')}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveRule(index)}
                        aria-label={t('bots.rolePermissions.passlistRemove')}
                        className="p-1 text-text-tertiary hover:text-destructive flex-shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newCommand}
                    onChange={(e) => {
                      setNewCommand(e.target.value);
                      setDuplicateRejected(false);
                    }}
                    placeholder={t('bots.rolePermissions.passlistAddPlaceholder')}
                    className="flex-1 px-3 py-1.5 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary font-mono text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={handleAddRule}
                    disabled={trimmedCommand === ''}
                    className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium bg-accent text-accent-foreground rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('bots.rolePermissions.passlistAdd')}
                  </button>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
                    <input
                      type="radio"
                      name="passlist-semantics"
                      checked={newSemantics === 'exact'}
                      onChange={() => setNewSemantics('exact')}
                      className="accent-accent"
                    />
                    {t('bots.rolePermissions.passlistSemanticsExact')}
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
                    <input
                      type="radio"
                      name="passlist-semantics"
                      checked={newSemantics === 'prefix'}
                      onChange={() => setNewSemantics('prefix')}
                      className="accent-accent"
                    />
                    {t('bots.rolePermissions.passlistSemanticsPrefix')}
                  </label>
                </div>

                {compositeDetected && (
                  <p className="text-[11px] text-destructive" role="alert">
                    {t('bots.rolePermissions.passlistCompositeRejected')}
                  </p>
                )}
                {duplicateRejected && !compositeDetected && (
                  <p className="text-[11px] text-destructive" role="alert">
                    {t('bots.rolePermissions.passlistDuplicate')}
                  </p>
                )}

                {candidateRule && (
                  <p className="text-[10px] text-text-tertiary">
                    {t(
                      newSemantics === 'exact'
                        ? 'bots.rolePermissions.passlistPreviewExact'
                        : 'bots.rolePermissions.passlistPreviewPrefix',
                    )}
                    {' · '}
                    <code className="font-mono">{candidateRule}</code>
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
);

BotRolePermissions.displayName = 'BotRolePermissions';

export default BotRolePermissions;
