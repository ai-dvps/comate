import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { WeComBotIsolationSettings, BashWhitelistEntry } from '../types/wecom-isolation';

interface IsolationSubTabProps {
  isolation: WeComBotIsolationSettings;
  onUpdate: (isolation: WeComBotIsolationSettings) => void;
}

const PLACEHOLDER_TYPES: Array<{ type: BashWhitelistEntry['args'][number] extends infer U ? U extends { type: string } ? U['type'] : never : never; label: string }> = [
  { type: 'user_path', label: '{{user_path}}' },
  { type: 'shared_path', label: '{{shared_path}}' },
  { type: 'any', label: '{{arg}}' },
];

function parseArgsInput(input: string): BashWhitelistEntry['args'] {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  return tokens.map((token) => {
    if (token === '{{user_path}}') return { type: 'user_path' };
    if (token === '{{shared_path}}') return { type: 'shared_path' };
    if (token === '{{arg}}') return { type: 'any' };
    return token;
  });
}

function formatArgsInput(args: BashWhitelistEntry['args']): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg.type === 'user_path') return '{{user_path}}';
      if (arg.type === 'shared_path') return '{{shared_path}}';
      if (arg.type === 'any') return '{{arg}}';
      return '';
    })
    .join(' ');
}

export function IsolationSubTab({ isolation, onUpdate }: IsolationSubTabProps) {
  const { t } = useTranslation('settings');
  const [newAdminId, setNewAdminId] = useState('');
  const [newDefaultSkill, setNewDefaultSkill] = useState('');
  const [newAdminSkill, setNewAdminSkill] = useState('');

  const update = (updates: Partial<WeComBotIsolationSettings>) => {
    onUpdate({ ...isolation, ...updates });
  };

  const addAdminId = () => {
    const value = newAdminId.trim();
    if (!value || isolation.adminUserIds.includes(value)) return;
    update({ adminUserIds: [...isolation.adminUserIds, value] });
    setNewAdminId('');
  };

  const removeAdminId = (value: string) => {
    update({ adminUserIds: isolation.adminUserIds.filter((id) => id !== value) });
  };

  const addSkill = (
    value: string,
    setter: (v: string) => void,
    list: string[],
    key: 'defaultAllowedSkills' | 'adminAllowedSkills',
  ) => {
    const trimmed = value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '');
    if (!trimmed || list.includes(trimmed)) return;
    update({ [key]: [...list, trimmed] });
    setter('');
  };

  const removeSkill = (key: 'defaultAllowedSkills' | 'adminAllowedSkills', value: string) => {
    update({ [key]: isolation[key].filter((s) => s !== value) });
  };

  const addBashEntry = () => {
    update({
      bashWhitelist: [
        ...isolation.bashWhitelist,
        { command: '', args: [{ type: 'user_path' }] },
      ],
    });
  };

  const updateBashEntry = (index: number, entry: BashWhitelistEntry) => {
    const next = [...isolation.bashWhitelist];
    next[index] = entry;
    update({ bashWhitelist: next });
  };

  const removeBashEntry = (index: number) => {
    update({ bashWhitelist: isolation.bashWhitelist.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-5 pt-4 max-w-xl">
      <div className="border border-border rounded p-3 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t('wecom.isolation.adminUsers.label')}
          </label>
          <p className="text-[10px] text-text-tertiary mb-2">{t('wecom.isolation.adminUsers.hint')}</p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {isolation.adminUserIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-bg border border-border rounded">
                <code className="font-mono text-text-secondary">{id}</code>
                <button
                  type="button"
                  onClick={() => removeAdminId(id)}
                  className="text-text-tertiary hover:text-destructive"
                  aria-label={t('wecom.isolation.remove')}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newAdminId}
              onChange={(e) => setNewAdminId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addAdminId();
                }
              }}
              placeholder={t('wecom.isolation.adminUsers.placeholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={addAdminId}
              className="px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
            >
              {t('wecom.isolation.add')}
            </button>
          </div>
        </div>
      </div>

      <div className="border border-border rounded p-3 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t('wecom.isolation.defaultSkills.label')}
          </label>
          <p className="text-[10px] text-text-tertiary mb-2">{t('wecom.isolation.defaultSkills.hint')}</p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {isolation.defaultAllowedSkills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-bg border border-border rounded">
                <code className="font-mono text-text-secondary">{skill}</code>
                <button
                  type="button"
                  onClick={() => removeSkill('defaultAllowedSkills', skill)}
                  className="text-text-tertiary hover:text-destructive"
                  aria-label={t('wecom.isolation.remove')}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newDefaultSkill}
              onChange={(e) => setNewDefaultSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSkill(newDefaultSkill, setNewDefaultSkill, isolation.defaultAllowedSkills, 'defaultAllowedSkills');
                }
              }}
              placeholder={t('wecom.isolation.defaultSkills.placeholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={() => addSkill(newDefaultSkill, setNewDefaultSkill, isolation.defaultAllowedSkills, 'defaultAllowedSkills')}
              className="px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
            >
              {t('wecom.isolation.add')}
            </button>
          </div>
        </div>
      </div>

      <div className="border border-border rounded p-3 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t('wecom.isolation.adminSkills.label')}
          </label>
          <p className="text-[10px] text-text-tertiary mb-2">{t('wecom.isolation.adminSkills.hint')}</p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {isolation.adminAllowedSkills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-bg border border-border rounded"
              >
                <code className="font-mono text-text-secondary">{skill}</code>
                <button
                  type="button"
                  onClick={() => removeSkill('adminAllowedSkills', skill)}
                  className="text-text-tertiary hover:text-destructive"
                  aria-label={t('wecom.isolation.remove')}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newAdminSkill}
              onChange={(e) => setNewAdminSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSkill(newAdminSkill, setNewAdminSkill, isolation.adminAllowedSkills, 'adminAllowedSkills');
                }
              }}
              placeholder={t('wecom.isolation.adminSkills.placeholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={() => addSkill(newAdminSkill, setNewAdminSkill, isolation.adminAllowedSkills, 'adminAllowedSkills')}
              className="px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
            >
              {t('wecom.isolation.add')}
            </button>
          </div>
        </div>
      </div>

      <div className="border border-border rounded p-3 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t('wecom.isolation.bashWhitelist.label')}
          </label>
          <p className="text-[10px] text-text-tertiary mb-2">{t('wecom.isolation.bashWhitelist.hint')}</p>
          <div className="space-y-2 mb-2">
            {isolation.bashWhitelist.map((entry, index) => (
              <div key={index} className="flex items-start gap-2 p-2 bg-bg rounded border border-border/50">
                <div className="flex-1 grid grid-cols-1 gap-2">
                  <div className="flex gap-2">
                    <input
                      value={entry.command}
                      onChange={(e) => updateBashEntry(index, { ...entry, command: e.target.value })}
                      placeholder={t('wecom.isolation.bashWhitelist.commandPlaceholder')}
                      className="flex-1 px-2 py-1 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                    />
                    <input
                      value={formatArgsInput(entry.args)}
                      onChange={(e) => updateBashEntry(index, { ...entry, args: parseArgsInput(e.target.value) })}
                      placeholder={t('wecom.isolation.bashWhitelist.argsPlaceholder')}
                      className="flex-[2] px-2 py-1 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary font-mono"
                    />
                  </div>
                  <input
                    value={entry.description ?? ''}
                    onChange={(e) => updateBashEntry(index, { ...entry, description: e.target.value })}
                    placeholder={t('wecom.isolation.bashWhitelist.descriptionPlaceholder')}
                    className="w-full px-2 py-1 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeBashEntry(index)}
                  className="p-1.5 text-text-tertiary hover:text-destructive"
                  aria-label={t('wecom.isolation.remove')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addBashEntry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded hover:bg-surface-hover text-text-secondary"
          >
            <Plus size={14} />
            {t('wecom.isolation.bashWhitelist.add')}
          </button>
          <p className="text-[10px] text-text-tertiary mt-2">
            {t('wecom.isolation.bashWhitelist.placeholders', { placeholders: PLACEHOLDER_TYPES.map((p) => p.label).join(', ') })}
          </p>
        </div>
      </div>

      <p className="text-[10px] text-text-tertiary">{t('wecom.isolation.freezeHint')}</p>
    </div>
  );
}
