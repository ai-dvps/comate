import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CreateTaskPayload, ScheduledTaskWithLatestRun } from '../stores/scheduled-task-store'
import { useScheduledTaskStore } from '../stores/scheduled-task-store'
import type { Workspace } from '../stores/workspace-store'
import { presetToCron } from '@server/services/cron-schedule.js'
import { detectPreset, type CronPresetName as Preset } from '../lib/cron-presets'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface ScheduledTaskFormProps {
  task: ScheduledTaskWithLatestRun | null
  workspaces: Workspace[]
  degraded: boolean
  onCancel: () => void
  onSaved: () => void
}

export function ScheduledTaskForm({ task, workspaces, degraded, onCancel, onSaved }: ScheduledTaskFormProps) {
  const { t } = useTranslation('scheduledTasks')
  const createTask = useScheduledTaskStore((s) => s.createTask)
  const updateTask = useScheduledTaskStore((s) => s.updateTask)

  const detected = detectPreset(task?.cronExpr ?? null)
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? workspaces[0]?.id ?? '')
  const [name, setName] = useState(task?.name ?? '')
  const [instruction, setInstruction] = useState(task?.instruction ?? '')
  const [scheduleType, setScheduleType] = useState<'once' | 'recurring'>(task?.scheduleType ?? 'once')
  const [scheduleTime, setScheduleTime] = useState(toLocalInputValue(task?.scheduleTime ?? null))
  const [preset, setPreset] = useState<Preset>(detected.preset)
  const [time, setTime] = useState(detected.time)
  const [dayOfWeek, setDayOfWeek] = useState(detected.dayOfWeek)
  const [cronExpr, setCronExpr] = useState(task?.cronExpr ?? '')
  const [notifyDesktop, setNotifyDesktop] = useState(task?.notifyDesktop ?? true)
  const [notifyInApp, setNotifyInApp] = useState(task?.notifyInApp ?? true)
  const [notifyWecom, setNotifyWecom] = useState(task?.notifyWecom ?? false)
  const [wecomRecipient, setWecomRecipient] = useState(task?.wecomRecipient ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    setError(null)
    setSaving(true)
    try {
      const payload: CreateTaskPayload = {
        name: name.trim(),
        instruction: instruction.trim(),
        scheduleType,
        notifyDesktop,
        notifyInApp,
        notifyWecom,
        wecomRecipient: wecomRecipient.trim() || null,
        scheduleTime: null,
        cronExpr: null,
      }
      if (scheduleType === 'once') {
        if (!scheduleTime) {
          setError(t('form.timeRequired'))
          setSaving(false)
          return
        }
        payload.scheduleTime = new Date(scheduleTime).toISOString()
        payload.cronExpr = null
      } else {
        const expr = preset === 'custom' ? cronExpr.trim() : presetToCron(preset, time, dayOfWeek)
        if (!expr) {
          setError(t('form.invalidCron'))
          setSaving(false)
          return
        }
        payload.cronExpr = expr
        payload.scheduleTime = null
      }

      if (task) {
        await updateTask(task.workspaceId, task.id, payload)
      } else {
        await createTask(workspaceId, payload)
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary shadow-sm transition-colors focus:outline-none focus:border-accent'
  const timeInputCls = `${inputCls} [color-scheme:light] dark:[color-scheme:dark]`
  const labelCls = 'block text-[11px] text-text-secondary mb-1'

  return (
    <div className="space-y-3">
      {degraded && (
        <div className="px-3 py-2 rounded-md bg-amber-500/10 text-amber-600 text-xs">{t('panel.degraded')}</div>
      )}
      {error && <div className="px-3 py-2 rounded-md bg-red-500/10 text-red-500 text-xs">{error}</div>}

      {!task && (
        <div>
          <label className={labelCls}>{t('panel.workspace')}</label>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <label className={labelCls}>{t('form.name')}</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('form.namePlaceholder')} />
      </div>

      <div>
        <label className={labelCls}>{t('form.instruction')}</label>
        <textarea
          className={`${inputCls} min-h-[80px] resize-y`}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={t('form.instructionPlaceholder')}
        />
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className={labelCls}>{t('form.scheduleType')}</label>
          <Select value={scheduleType} onValueChange={(v) => setScheduleType(v as 'once' | 'recurring')}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">{t('form.once')}</SelectItem>
              <SelectItem value="recurring">{t('form.recurring')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {scheduleType === 'once' && (
          <div className="flex-1">
            <label className={labelCls}>{t('form.scheduleTime')}</label>
            <input
              type="datetime-local"
              className={timeInputCls}
              value={scheduleTime}
              min={toLocalInputValue(new Date().toISOString())}
              onChange={(e) => setScheduleTime(e.target.value)}
            />
          </div>
        )}
      </div>

      {scheduleType === 'recurring' && (
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelCls}>{t('form.preset')}</label>
            <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">{t('form.hourly')}</SelectItem>
                <SelectItem value="daily">{t('form.daily')}</SelectItem>
                <SelectItem value="weekdays">{t('form.weekdays')}</SelectItem>
                <SelectItem value="weekly">{t('form.weekly')}</SelectItem>
                <SelectItem value="custom">{t('form.customCron')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {preset !== 'custom' && (
            <div className="flex-1">
              <label className={labelCls}>{t('form.time')}</label>
              <input type="time" className={timeInputCls} value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          {preset === 'weekly' && (
            <div className="flex-1">
              <label className={labelCls}>{t('form.dayOfWeek')}</label>
              <Select value={String(dayOfWeek)} onValueChange={(v) => setDayOfWeek(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t(`weekday.${d}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {preset === 'custom' && (
            <div className="flex-[2]">
              <label className={labelCls}>cron</label>
              <input className={inputCls} value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder={t('form.cronPlaceholder')} />
            </div>
          )}
        </div>
      )}

      <div>
        <label className={labelCls}>{t('form.notify')}</label>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={notifyDesktop} onChange={(e) => setNotifyDesktop(e.target.checked)} />
            {t('form.notifyDesktop')}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={notifyInApp} onChange={(e) => setNotifyInApp(e.target.checked)} />
            {t('form.notifyInApp')}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={notifyWecom} onChange={(e) => setNotifyWecom(e.target.checked)} />
            {t('form.notifyWecom')}
          </label>
        </div>
        {notifyWecom && (
          <input
            className={`${inputCls} mt-2`}
            value={wecomRecipient}
            onChange={(e) => setWecomRecipient(e.target.value)}
            placeholder={t('form.wecomRecipient')}
          />
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:bg-surface-hover">
          {t('form.cancel')}
        </button>
        <button
          onClick={() => void handleSubmit()}
          disabled={saving || !name.trim() || !instruction.trim()}
          className="px-3 py-1.5 rounded-md text-xs bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {t('form.save')}
        </button>
      </div>
    </div>
  )
}
