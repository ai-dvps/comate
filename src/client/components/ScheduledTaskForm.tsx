import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ScheduledTaskWithLatestRun } from '../stores/scheduled-task-store'
import { useScheduledTaskStore } from '../stores/scheduled-task-store'
import type { Workspace } from '../stores/workspace-store'
import { presetToCron } from '@server/services/cron-schedule.js'
import { detectPreset, type CronPresetName as Preset } from '../lib/cron-presets'

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
      const payload: Record<string, unknown> = {
        name: name.trim(),
        instruction: instruction.trim(),
        scheduleType,
        notifyDesktop,
        notifyInApp,
        notifyWecom,
        wecomRecipient: wecomRecipient.trim() || null,
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
        await createTask(workspaceId, payload as never)
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-2 py-1.5 rounded-md border border-border bg-bg text-xs text-text-primary focus:outline-none focus:border-accent'
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
          <select className={inputCls} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
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
          <select className={inputCls} value={scheduleType} onChange={(e) => setScheduleType(e.target.value as 'once' | 'recurring')}>
            <option value="once">{t('form.once')}</option>
            <option value="recurring">{t('form.recurring')}</option>
          </select>
        </div>
        {scheduleType === 'once' && (
          <div className="flex-1">
            <label className={labelCls}>{t('form.scheduleTime')}</label>
            <input
              type="datetime-local"
              className={inputCls}
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
            <select className={inputCls} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              <option value="hourly">{t('form.hourly')}</option>
              <option value="daily">{t('form.daily')}</option>
              <option value="weekdays">{t('form.weekdays')}</option>
              <option value="weekly">{t('form.weekly')}</option>
              <option value="custom">{t('form.customCron')}</option>
            </select>
          </div>
          {preset !== 'custom' && (
            <div className="flex-1">
              <label className={labelCls}>{t('form.time')}</label>
              <input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          {preset === 'weekly' && (
            <div className="flex-1">
              <label className={labelCls}>{t('form.dayOfWeek')}</label>
              <select className={inputCls} value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? 'Sun' : `D${d}`}
                  </option>
                ))}
              </select>
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
