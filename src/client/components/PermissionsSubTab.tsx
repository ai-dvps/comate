import { useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ALLOW_ALL_PRESET,
  CATEGORY_TOOLS,
  SAFE_PRESET,
  TOOL_CATEGORIES,
  type CategoryDecision,
  type ToolCategory,
  type ToolPermissionPolicy,
  type ToolPosture,
} from '../types/wecom-permissions';
import { useWecomPermissionsPrompt } from '../hooks/use-wecom-permissions-prompt';

interface PermissionsSubTabProps {
  /** Current policy. When undefined, the workspace has no explicit policy set (grandfathered or default). UI treats this as 'allow-all'. */
  policy: ToolPermissionPolicy | undefined;
  /** Called with the updated policy on every change. */
  onUpdate: (policy: ToolPermissionPolicy) => void;
  /** Workspace ID — used to key the grandfathering prompt's localStorage state. */
  workspaceId: string;
  /** True when the workspace is bot-enabled with no explicit policy (the grandfathered case from R7/R8). */
  needsUpgradePrompt: boolean;
  /** Apply the safe preset AND immediately persist (used by the grandfathering banner's CTA). */
  onApplySafePreset: () => Promise<void>;
}

/**
 * Permissions sub-tab body. Renders a posture selector (Allow all / Safe /
 * Custom) followed by six category cards. Each card has a default-toggle and
 * an expandable list of tools in that category, each with a 3-state override
 * control (Inherit / Always allow / Always deny).
 *
 * State-transition rules:
 *  - Selecting Allow all or Safe rewrites categoryDefaults and sets posture
 *    to that value; existing overrides are preserved.
 *  - Any manual toggle or override change flips posture to 'custom'. The
 *    selector never auto-snaps back to a named preset from Custom even if the
 *    toggles happen to match — return to a named preset requires explicit click.
 *
 * Grandfathering banner (R7/R8): when `needsUpgradePrompt` is true and the
 * admin has not yet dismissed it for this workspace+browser, an info banner
 * appears above the posture selector. "Switch to Safe preset" auto-saves
 * (calls onApplySafePreset) so the banner does not leave the workspace in an
 * inconsistent state if the admin closes settings without clicking Save.
 * "Dismiss" calls markShown without changing policy.
 */
export function PermissionsSubTab({
  policy,
  onUpdate,
  workspaceId,
  needsUpgradePrompt,
  onApplySafePreset,
}: PermissionsSubTabProps) {
  const { t } = useTranslation('settings');
  const [expandedCategories, setExpandedCategories] = useState<Set<ToolCategory>>(new Set());

  const { shouldShow: shouldShowBanner, markShown } = useWecomPermissionsPrompt({
    workspaceId,
    needsUpgradePrompt,
  });

  // Effective policy: treat undefined as allow-all for display purposes
  const effective: ToolPermissionPolicy = policy ?? ALLOW_ALL_PRESET;

  const toggleCategoryExpanded = (cat: ToolCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const applyPreset = (preset: ToolPosture) => {
    const sourcePreset = preset === 'safe' ? SAFE_PRESET : preset === 'allow-all' ? ALLOW_ALL_PRESET : null;
    if (!sourcePreset) {
      onUpdate({ ...effective, posture: 'custom' });
      return;
    }
    // Preserve overrides when applying a preset — the preset only rewrites
    // category defaults and posture.
    onUpdate({
      posture: sourcePreset.posture,
      categoryDefaults: { ...sourcePreset.categoryDefaults },
      overrides: effective.overrides,
    });
  };

  const setCategoryDefault = (cat: ToolCategory, value: CategoryDecision) => {
    const nextDefaults = { ...effective.categoryDefaults, [cat]: value };
    onUpdate({
      posture: 'custom',
      categoryDefaults: nextDefaults,
      overrides: effective.overrides,
    });
  };

  const setOverride = (_cat: ToolCategory, tool: string, value: 'allow' | 'deny' | 'inherit') => {
    const nextOverrides = { ...(effective.overrides || {}) };
    if (value === 'inherit') {
      delete nextOverrides[tool];
    } else {
      nextOverrides[tool] = value;
    }
    const hasOverrides = Object.keys(nextOverrides).length > 0;
    onUpdate({
      posture: 'custom',
      categoryDefaults: effective.categoryDefaults,
      overrides: hasOverrides ? nextOverrides : undefined,
    });
  };

  return (
    <div className="space-y-4 pt-4">
      {/* Grandfathering one-time banner (R7/R8) */}
      {shouldShowBanner && (
        <div className="border border-yellow-500/40 bg-yellow-500/10 rounded p-3 space-y-2" role="status">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-text-primary">
                {t('wecom.banner.title')}
              </div>
              <div className="text-[11px] text-text-secondary mt-1">
                {t('wecom.banner.body')}
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    // Auto-save: onApplySafePreset both updates form state and
                    // persists. markShown is called first so that if the save
                    // fails, the banner still disappears and the user can
                    // retry by editing the policy directly.
                    markShown();
                    onApplySafePreset().catch(() => {
                      // Save errors are surfaced via the existing error path;
                      // the banner is already dismissed at this point.
                    });
                  }}
                  className="px-3 py-1 text-[11px] font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
                >
                  {t('wecom.banner.switchToSafe')}
                </button>
                <button
                  type="button"
                  onClick={markShown}
                  className="px-3 py-1 text-[11px] font-medium text-text-secondary hover:text-text-primary"
                >
                  {t('wecom.banner.dismiss')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Posture selector */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('wecom.posture.label')}
        </label>
        <div className="flex gap-2">
          <PostureButton
            label={t('wecom.posture.allowAll')}
            description={t('wecom.posture.allowAllDescription')}
            active={effective.posture === 'allow-all'}
            onClick={() => applyPreset('allow-all')}
          />
          <PostureButton
            label={t('wecom.posture.safe')}
            description={t('wecom.posture.safeDescription')}
            active={effective.posture === 'safe'}
            onClick={() => applyPreset('safe')}
          />
          <PostureButton
            label={t('wecom.posture.custom')}
            description={t('wecom.posture.customDescription')}
            active={effective.posture === 'custom'}
            onClick={() => applyPreset('custom')}
          />
        </div>
        <p className="text-[10px] text-text-tertiary mt-2">{t('wecom.freezeHint')}</p>
      </div>

      {/* Category cards */}
      <div className="space-y-2">
        {TOOL_CATEGORIES.map((cat) => (
          <CategoryCard
            key={cat}
            category={cat}
            defaultDecision={effective.categoryDefaults[cat]}
            overrides={effective.overrides || {}}
            expanded={expandedCategories.has(cat)}
            onToggleExpanded={() => toggleCategoryExpanded(cat)}
            onSetDefault={(value) => setCategoryDefault(cat, value)}
            onSetOverride={(tool, value) => setOverride(cat, tool, value)}
          />
        ))}
      </div>

      {/* MCP / Skills audit gap note */}
      <p className="text-[10px] text-text-tertiary mt-2">{t('wecom.mcpGapNote')}</p>
    </div>
  );
}

function PostureButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={description}
      className={`flex-1 px-3 py-2 text-xs font-medium rounded border transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-text-primary'
          : 'border-border text-text-secondary hover:border-text-tertiary'
      }`}
    >
      {label}
    </button>
  );
}

function CategoryCard({
  category,
  defaultDecision,
  overrides,
  expanded,
  onToggleExpanded,
  onSetDefault,
  onSetOverride,
}: {
  category: ToolCategory;
  defaultDecision: CategoryDecision;
  overrides: Record<string, CategoryDecision>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSetDefault: (value: CategoryDecision) => void;
  onSetOverride: (tool: string, value: 'allow' | 'deny' | 'inherit') => void;
}) {
  const { t } = useTranslation('settings');
  const tools = CATEGORY_TOOLS[category];

  return (
    <div className="border border-border rounded">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-text-primary">
            {t(`wecom.category.${category}.name`)}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5 truncate">
            {t(`wecom.category.${category}.description`)}
          </div>
        </div>
        <div className="flex items-center gap-2 ml-2">
          <DecisionToggle value={defaultDecision} onChange={onSetDefault} />
          {tools.length > 0 && (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-label={expanded ? 'collapse' : 'expand'}
              className="text-text-tertiary hover:text-text-primary"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
        </div>
      </div>
      {expanded && tools.length > 0 && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1">
          <div className="text-[10px] text-text-tertiary mb-1">{t('wecom.override.label')}</div>
          {tools.map((tool) => (
            <ToolOverrideRow
              key={tool}
              tool={tool}
              value={overrides[tool]}
              onChange={(v) => onSetOverride(tool, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionToggle({
  value,
  onChange,
}: {
  value: CategoryDecision;
  onChange: (value: CategoryDecision) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="inline-flex rounded border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => onChange('allow')}
        className={`px-2 py-1 text-[10px] font-medium ${
          value === 'allow' ? 'bg-success/20 text-success' : 'text-text-secondary hover:bg-border/50'
        }`}
      >
        {t('wecom.defaultToggle.allow')}
      </button>
      <button
        type="button"
        onClick={() => onChange('deny')}
        className={`px-2 py-1 text-[10px] font-medium ${
          value === 'deny' ? 'bg-destructive/20 text-destructive' : 'text-text-secondary hover:bg-border/50'
        }`}
      >
        {t('wecom.defaultToggle.deny')}
      </button>
    </div>
  );
}

function ToolOverrideRow({
  tool,
  value,
  onChange,
}: {
  tool: string;
  value: CategoryDecision | undefined;
  onChange: (value: 'allow' | 'deny' | 'inherit') => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex items-center justify-between">
      <code className="text-[10px] text-text-secondary font-mono">{tool}</code>
      <div className="inline-flex rounded border border-border overflow-hidden">
        <button
          type="button"
          onClick={() => onChange('inherit')}
          className={`px-2 py-0.5 text-[10px] ${
            value === undefined
              ? 'bg-border text-text-primary'
              : 'text-text-tertiary hover:bg-border/50'
          }`}
          title={t('wecom.override.inheritSuffix')}
        >
          {t('wecom.override.inherit')}
        </button>
        <button
          type="button"
          onClick={() => onChange('allow')}
          className={`px-2 py-0.5 text-[10px] ${
            value === 'allow'
              ? 'bg-success/20 text-success'
              : 'text-text-tertiary hover:bg-border/50'
          }`}
        >
          {t('wecom.override.alwaysAllow')}
        </button>
        <button
          type="button"
          onClick={() => onChange('deny')}
          className={`px-2 py-0.5 text-[10px] ${
            value === 'deny'
              ? 'bg-destructive/20 text-destructive'
              : 'text-text-tertiary hover:bg-border/50'
          }`}
        >
          {t('wecom.override.alwaysDeny')}
        </button>
      </div>
    </div>
  );
}
