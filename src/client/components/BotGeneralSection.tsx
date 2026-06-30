import { useTranslation } from 'react-i18next';
import type { Workspace } from '../stores/workspace-store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import type { BotFormData } from './bot-form-utils';

interface BotGeneralSectionProps {
  form: BotFormData;
  onUpdate: (patch: Partial<BotFormData>) => void;
  workspaces: Workspace[];
}

export default function BotGeneralSection({ form, onUpdate, workspaces }: BotGeneralSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-1">
          {t('bots.name')} *
        </label>
        <input
          value={form.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder={t('bots.namePlaceholder')}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-1">
          {t('bots.activeWorkspace')}
        </label>
        <Select
          value={form.activeWorkspaceId}
          onValueChange={(value) => onUpdate({ activeWorkspaceId: value })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('bots.noActiveWorkspace')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('bots.noActiveWorkspace')}</SelectItem>
            {workspaces.map((ws) => (
              <SelectItem key={ws.id} value={ws.id}>
                {ws.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
