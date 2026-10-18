import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpServerView } from '@comate/api-contracts'
import { McpApiError } from '../stores/mcp-store'

type Pair = { key: string; value: string }
export interface McpServerEditorHandle { save(): Promise<void>; isDirty(): boolean }
interface Props {
  scope: string
  server?: McpServerView
  override?: boolean
  onSave(input: { scope: string; id?: string; [key: string]: unknown }): Promise<void>
  onCancel(): void
}
const fieldClass = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40'
const buttonClass = 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-50'

function CredentialFields({ pairs, setPairs, label }: { pairs: Pair[]; setPairs(value: Pair[]): void; label: string }) {
  const { t } = useTranslation('settings')
  return <fieldset className="space-y-2">
    <legend className="text-xs font-medium mb-2">{label}</legend>
    {pairs.map((pair, index) => <div key={index} className="flex flex-wrap gap-2">
      <label className="min-w-0 flex-1"><span className="sr-only">{label} {t('mcp.key')} {index + 1}</span>
        <input className={fieldClass} value={pair.key} required autoComplete="off" placeholder={t('mcp.key')}
          onChange={event => setPairs(pairs.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /></label>
      <label className="min-w-0 flex-1"><span className="sr-only">{label} {t('mcp.value')} {index + 1}</span>
        <input className={fieldClass} type="password" value={pair.value} autoComplete="new-password" placeholder={t('mcp.value')}
          onChange={event => setPairs(pairs.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} /></label>
      <button type="button" className={buttonClass} aria-label={`${t('mcp.remove')} ${label} ${index + 1}`} title={`${t('mcp.remove')} ${label} ${index + 1}`}
        onClick={() => setPairs(pairs.filter((_, i) => i !== index))}>{t('mcp.remove')}</button>
    </div>)}
    <button type="button" className={buttonClass} onClick={() => setPairs([...pairs, { key: '', value: '' }])}>{t('mcp.addCredential', { label })}</button>
  </fieldset>
}

const McpServerEditor = forwardRef<McpServerEditorHandle, Props>(function McpServerEditor({ scope, server, override, onSave, onCancel }, ref) {
  const { t } = useTranslation('settings')
  const form = useRef<HTMLFormElement>(null)
  const [name, setName] = useState(server?.name ?? '')
  const [enabled, setEnabled] = useState(server?.enabled ?? true)
  const [replace, setReplace] = useState(!server || Boolean(override) || Boolean(server.error) || server.kind === 'disabled')
  const [type, setType] = useState<'stdio' | 'http' | 'sse'>(server?.type ?? 'stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState<string[]>([])
  const [env, setEnv] = useState<Pair[]>([])
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<Pair[]>([])
  const [oauth, setOauth] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [clientMetadataUrl, setClientMetadataUrl] = useState('')
  const [scopes, setScopes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!form.current?.reportValidity() || busy) throw new Error(t('mcp.checkFields'))
    setBusy(true); setError('')
    try {
      const entries = (pairs: Pair[]) => {
        if (new Set(pairs.map(pair => pair.key)).size !== pairs.length) throw new Error(t('mcp.duplicateKey'))
        return Object.fromEntries(pairs.map(pair => [pair.key, pair.value]))
      }
      const connection = type === 'stdio' ? { type, command, args, env: entries(env) }
        : { type, url, headers: entries(headers), ...(oauth ? { oauth: {
          ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}),
          ...(clientMetadataUrl ? { clientMetadataUrl } : {}), ...(scopes.trim() ? { scopes: scopes.trim().split(/\s+/) } : {}),
        } } : {}) }
      await onSave({ scope, name, enabled, kind: 'server',
        ...(server && !override ? { id: server.id, expectedRevision: server.revision } : {}),
        ...(replace ? { connection } : {}) })
    } catch (error) {
      setError(error instanceof McpApiError && error.status === 409 ? t('mcp.conflict') : error instanceof Error ? error.message : t('mcp.failed'))
      throw error
    } finally { setBusy(false) }
  }
  useImperativeHandle(ref, () => ({ save, isDirty: () => name !== (server?.name ?? '') || enabled !== (server?.enabled ?? true) ||
    Boolean(command || url || args.length || env.length || headers.length || oauth || (server && !override && replace)) }))

  return <form ref={form} className="space-y-4 rounded-lg border border-border p-4 bg-surface-secondary/40"
    onSubmit={event => { event.preventDefault(); void save().catch(() => undefined) }}>
    <h3 className="text-sm font-medium">{t(override ? 'mcp.override' : server ? 'mcp.edit' : 'mcp.add')}</h3>
    {override && <p className="text-xs text-text-secondary">{t('mcp.overrideHint')}</p>}
    <label className="block space-y-1"><span className="text-xs">{t('mcp.name')}</span>
      <input className={fieldClass} value={name} required maxLength={128} onChange={event => setName(event.target.value)} autoFocus /></label>
    <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('mcp.enabled')}</label>
    {server && !override && <>
      <p className="text-xs text-text-secondary break-all">{server.command ?? server.url} · {t('mcp.savedFields', { args: server.argCount, keys: [...server.envKeys, ...server.headerKeys].join(', ') || '—' })}</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />{t('mcp.replace')}</label>
    </>}
    {replace && <fieldset className="space-y-4" disabled={busy}>
      <p className="text-xs text-text-secondary">{t('mcp.replaceHint')}</p>
      <label className="block space-y-1"><span className="text-xs">{t('mcp.transport')}</span>
        <select className={fieldClass} value={type} onChange={event => setType(event.target.value as typeof type)}>
          <option value="stdio">{t('mcp.stdio')}</option><option value="http">HTTP</option><option value="sse">SSE</option>
        </select></label>
      {type === 'stdio' ? <>
        <label className="block space-y-1"><span className="text-xs">{t('mcp.command')}</span><input className={fieldClass} required value={command} onChange={event => setCommand(event.target.value)} autoComplete="off" /></label>
        <fieldset className="space-y-2"><legend className="text-xs mb-2">{t('mcp.arguments')}</legend>
          {args.map((arg, index) => <div className="flex gap-2" key={index}>
            <label className="flex-1 min-w-0"><span className="sr-only">{t('mcp.argument', { index: index + 1 })}</span>
              <input className={fieldClass} value={arg} onChange={event => setArgs(args.map((value, i) => i === index ? event.target.value : value))} autoComplete="off" /></label>
            <button type="button" className={buttonClass} onClick={() => setArgs(args.filter((_, i) => i !== index))} aria-label={`${t('mcp.remove')} ${t('mcp.argument', { index: index + 1 })}`} title={`${t('mcp.remove')} ${t('mcp.argument', { index: index + 1 })}`}>{t('mcp.remove')}</button>
          </div>)}
          <button type="button" className={buttonClass} onClick={() => setArgs([...args, ''])}>{t('mcp.addArgument')}</button>
        </fieldset>
        <CredentialFields pairs={env} setPairs={setEnv} label={t('mcp.environment')} />
      </> : <>
        <label className="block space-y-1"><span className="text-xs">{t('mcp.url')}</span><input className={fieldClass} required type="url" value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" /></label>
        <CredentialFields pairs={headers} setPairs={setHeaders} label={t('mcp.headers')} />
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={oauth} onChange={event => setOauth(event.target.checked)} />{t('mcp.oauth')}</label>
        {oauth && <div className="space-y-3">
          <p className="text-xs text-text-secondary">{t('mcp.oauthHint')}</p>
          <label className="block text-xs space-y-1"><span>{t('mcp.clientId')}</span><input className={fieldClass} value={clientId} onChange={event => setClientId(event.target.value)} autoComplete="off" /></label>
          <label className="block text-xs space-y-1"><span>{t('mcp.clientSecret')}</span><input className={fieldClass} type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} autoComplete="new-password" /></label>
          <label className="block text-xs space-y-1"><span>{t('mcp.metadataUrl')}</span><input className={fieldClass} type="url" value={clientMetadataUrl} onChange={event => setClientMetadataUrl(event.target.value)} /></label>
          <label className="block text-xs space-y-1"><span>{t('mcp.scopes')}</span><input className={fieldClass} value={scopes} onChange={event => setScopes(event.target.value)} /></label>
        </div>}
      </>}
    </fieldset>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex gap-2"><button type="submit" disabled={busy} className="rounded-md bg-accent px-4 py-2 text-xs text-white disabled:opacity-50">{t(busy ? 'mcp.saving' : 'mcp.save')}</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>{t('mcp.cancel')}</button></div>
  </form>
})
export default McpServerEditor
