import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { WeComBotIsolationSettings } from '../types/wecom-isolation';

interface IsolationSubTabProps {
  isolation: WeComBotIsolationSettings;
  onUpdate: (isolation: WeComBotIsolationSettings) => void;
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

      <p className="text-[10px] text-text-tertiary">{t('wecom.isolation.freezeHint')}</p>
    </div>
  );
}
