import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpConnectionStatus, McpServerView } from '@comate/api-contracts'
import { useWorkspaceStore } from '../stores/workspace-store'
import { McpApiError, mcpRequest, useMcpStore } from '../stores/mcp-store'
import { openExternal } from '../lib/desktop-api'
import McpServerEditor, { type McpServerEditorHandle } from './McpServerEditor'

export interface McpSettingsPageHandle { isDirty(): boolean; save(): Promise<void>; discard(): void }
interface Authorization { id: string; entryId: string; state: string; authorizationUrl?: string; error?: string }
const buttonClass = 'rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-40'

const McpSettingsPage = forwardRef<McpSettingsPageHandle>(function McpSettingsPage(_props, ref) {
  const { t } = useTranslation('settings')
  const workspaces = useWorkspaceStore(state => state.workspaces)
  const { servers, scope, loading, error, applications, load, save, remove, importConfiguration, loadApplications } = useMcpStore()
  const [editor, setEditor] = useState<{ server?: McpServerView; override?: boolean } | null>(null)
  const editorRef = useRef<McpServerEditorHandle>(null)
  const [importing, setImporting] = useState(false)
  const [json, setJson] = useState('')
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, McpConnectionStatus>>({})
  const [authorization, setAuthorization] = useState<Authorization | null>(null)
  const currentScope = useRef(scope)
  currentScope.current = scope
  const visibleApplications = applications.filter(application => scope === 'global' || scope === `workspace:${application.workspaceId}`)

  useEffect(() => { void load('global') }, [load])
  useEffect(() => {
    let active = true
    const refresh = () => { if (active) void loadApplications().catch(() => undefined) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [loadApplications])
  useEffect(() => {
    if (!authorization || authorization.state !== 'waiting') return
    let active = true
    const timer = setInterval(() => {
      void mcpRequest<Authorization>(`/oauth/${authorization.id}`).then(result => {
        if (!active) return
        setAuthorization(result)
        if (result.state !== 'waiting') void load(currentScope.current)
      }).catch(() => { if (active) setAuthorization(previous => previous ? { ...previous, state: 'failed', error: t('mcp.failed') } : null) })
    }, 1200)
    return () => { active = false; clearInterval(timer) }
  }, [authorization, load, t])

  const run = async (id: string, fn: () => Promise<void>) => {
    const operationScope = scope
    setBusy(id); setActionError(''); setNotice('')
    try { await fn() }
    catch (error) { if (currentScope.current === operationScope) setActionError(error instanceof McpApiError && error.status === 409 ? t('mcp.conflict') : error instanceof Error ? error.message : t('mcp.failed')) }
    finally { if (currentScope.current === operationScope) setBusy(null) }
  }
  const importJson = async () => {
    await importConfiguration(scope, json)
    setImporting(false); setJson(''); setNotice(t('mcp.saved'))
  }
  useImperativeHandle(ref, () => ({
    isDirty: () => Boolean(editorRef.current?.isDirty() || (importing && json.trim())),
    save: async () => { if (editorRef.current) await editorRef.current.save(); else if (importing) await importJson() },
    discard: () => { setEditor(null); setImporting(false); setJson('') },
  }))

  const switchScope = (value: string) => {
    setProbes({}); setNotice(''); setActionError(''); setBusy(null)
    void load(value)
  }
  const probe = async (server: McpServerView) => {
    const requestedScope = scope
    const result = await mcpRequest<{ connection: McpConnectionStatus }>(`/${server.id}/test`, 'POST',
      scope.startsWith('workspace:') ? { workspaceId: scope.slice(10) } : {})
    if (currentScope.current === requestedScope) setProbes(previous => ({ ...previous, [server.id]: result.connection }))
  }
  const signIn = async (server: McpServerView) => {
    const result = await mcpRequest<Authorization>(`/${server.id}/oauth`, 'POST')
    setAuthorization(result)
    if (result.authorizationUrl) await openExternal(result.authorizationUrl)
  }
  return <section className="space-y-5 p-4 sm:p-6 max-w-4xl mx-auto w-full text-text-primary">
    <div><h2 className="text-base font-medium">{t('mcp.title')}</h2><p className="mt-1 text-xs text-text-secondary leading-relaxed">{t('mcp.description')}</p></div>
    <div className="flex flex-wrap gap-3 items-end">
      <label className="min-w-0 flex-1 text-xs space-y-1"><span>{t('mcp.scope')}</span>
        <select className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={scope} disabled={Boolean(editor || importing || busy)} onChange={event => switchScope(event.target.value)}>
          <option value="global">{t('mcp.global')}</option>
          {workspaces.map(workspace => <option key={workspace.id} value={`workspace:${workspace.id}`}>{workspace.name}</option>)}
        </select></label>
      <button className={buttonClass} disabled={Boolean(editor || importing)} onClick={() => { setActionError(''); setEditor({}) }}>{t('mcp.add')}</button>
      <button className={buttonClass} disabled={Boolean(editor || importing || loading)} onClick={() => setImporting(true)}>{t('mcp.import')}</button>
      <button className={buttonClass} disabled={loading} onClick={() => { void load(scope); void loadApplications().catch(() => undefined) }}>{t('mcp.refresh')}</button>
    </div>
    {scope !== 'global' && <p className="text-xs text-text-secondary">{t('mcp.inheritanceHint')}</p>}
    {notice && <p role="status" className="text-xs text-accent">{notice}</p>}
    {(error || actionError) && <p role="alert" className="text-xs text-destructive">{error || actionError}</p>}
    {editor && <McpServerEditor key={`${scope}:${editor.server?.id ?? 'new'}:${editor.override ?? false}`} ref={editorRef} scope={scope} {...editor}
      onSave={async input => { await save(input); setEditor(null); setNotice(t('mcp.saved')) }} onCancel={() => setEditor(null)} />}
    {importing && <form className="space-y-3 border border-border p-4 rounded-lg" onSubmit={event => { event.preventDefault(); void run('import', importJson) }}>
      <label className="block text-xs space-y-2"><span>{t('mcp.importJson')}</span><textarea autoFocus required rows={8} value={json} autoComplete="off"
        className="w-full border border-border bg-surface rounded-md p-3 font-mono text-xs resize-y" placeholder={'{"mcpServers": {"example": {"command": "npx", "args": ["example-mcp"]}}}'} onChange={event => setJson(event.target.value)} /></label>
      <p className="text-xs text-text-secondary">{t('mcp.importHint')}</p>
      <div className="flex gap-2"><button type="submit" className={buttonClass} disabled={Boolean(busy)}>{t('mcp.import')}</button>
        <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => { setImporting(false); setJson('') }}>{t('mcp.cancel')}</button></div>
    </form>}
    {authorization && <div className="border border-border rounded-lg p-4 space-y-2 text-xs" role="status">
      <p>{servers.find(server => server.id === authorization.entryId)?.name ?? authorization.entryId.slice(0, 8)} · {t('mcp.oauthState', { state: t(`mcp.authStates.${authorization.state}`) })}</p>
      {authorization.error && <p className="text-destructive">{authorization.error}</p>}
      {authorization.state === 'waiting' && <div className="flex gap-2">
        <button className={buttonClass} onClick={() => { if (authorization.authorizationUrl) void run('oauth', () => openExternal(authorization.authorizationUrl!)) }}>{t('mcp.openLogin')}</button>
        <button className={buttonClass} onClick={() => { void run('oauth', async () => { await mcpRequest(`/oauth/${authorization.id}`, 'DELETE'); setAuthorization({ ...authorization, state: 'cancelled' }) }) }}>{t('mcp.cancelLogin')}</button>
      </div>}
    </div>}
    {loading ? <p role="status" className="text-xs text-text-secondary">{t('mcp.loading')}</p> : servers.length === 0 && !error ? <div className="border border-dashed border-border rounded-lg py-8 text-center text-sm text-text-secondary">{t('mcp.empty')}</div> : null}
    {!loading && servers.map(server => <article key={server.id} className="border border-border rounded-lg p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-sm break-all">{server.name}</h3>
        <span className="rounded bg-surface-hover px-2 py-0.5 text-[10px] text-text-secondary">{t(server.inherited ? 'mcp.inherited' : server.scope === 'global' ? 'mcp.global' : 'mcp.workspace')}</span>
        <span className="text-xs text-text-tertiary">{server.type?.toUpperCase()} · {t(server.kind === 'disabled' || !server.enabled ? 'mcp.disabled' : 'mcp.enabled')}{server.overridden ? ` · ${t('mcp.overridden')}` : ''}</span>
      </div>
      <p className="font-mono text-xs text-text-secondary break-all">{server.command ?? server.url}</p>
      {server.oauth && <p className="text-xs">OAuth · {t(`mcp.authStates.${server.authorization}`)}</p>}
      {server.error && <p role="alert" className="text-xs text-destructive">{server.error}</p>}
      <div className="flex flex-wrap gap-2">
        {server.inherited ? <>
          <button className={buttonClass} disabled={Boolean(busy || editor || server.overridden)} onClick={() => setEditor({ server, override: true })}>{t('mcp.override')}</button>
          <button className={buttonClass} disabled={Boolean(busy || server.overridden)} onClick={() => { void run(server.id, () => save({ scope, name: server.name, kind: 'disabled', enabled: false })) }}>{t('mcp.disableWorkspace')}</button>
        </> : <>
          <button className={buttonClass} disabled={Boolean(busy || editor)} onClick={() => setEditor({ server })}>{t('mcp.edit')}</button>
          {server.kind === 'server' && <button className={buttonClass} disabled={Boolean(busy)} onClick={() => { void run(server.id, () => save({ scope, id: server.id, expectedRevision: server.revision, name: server.name, enabled: !server.enabled })) }}>{t(server.enabled ? 'mcp.disable' : 'mcp.enable')}</button>}
          <button className={buttonClass} disabled={Boolean(busy)} onClick={() => { void run(server.id, () => remove(server)) }}>{t(scope === 'global' ? 'mcp.remove' : 'mcp.removeOverride')}</button>
        </>}
        {server.kind === 'server' && !server.overridden && <>
          <button className={buttonClass} disabled={Boolean(busy)} onClick={() => { void run(server.id, () => probe(server)) }}>{t(busy === server.id ? 'mcp.testing' : 'mcp.test')}</button>
          {server.oauth && <button className={buttonClass} disabled={Boolean(busy)} onClick={() => { void run(server.id, () => signIn(server)) }}>{t('mcp.signIn')}</button>}
        </>}
      </div>
      {probes[server.id] && <div className="text-xs space-y-2" role="status"><p>{t(`mcp.connectionStates.${probes[server.id].state}`)} {probes[server.id].error}</p>
        {probes[server.id].state === 'connected' && <><p>{t('mcp.tools', { count: probes[server.id].tools?.length ?? 0 })}</p>
          <ul className="space-y-1 max-h-52 overflow-auto">{probes[server.id].tools?.map(tool => <li key={tool.name} className="break-words"><span className="font-mono">{tool.name}</span>{tool.description ? ` — ${tool.description}` : ''}</li>)}</ul></>}
      </div>}
    </article>)}
    {visibleApplications.length > 0 && <div className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-medium">{t('mcp.applicationTitle')}</h3>
      <p className="text-xs text-text-secondary">{t('mcp.applicationHint')}</p>
      {visibleApplications.map(application => <div key={`${application.sessionId}:${application.name}`} className="flex flex-wrap items-center gap-2 text-xs">
        <span className="break-all">{application.name} · {application.backend} · {application.sessionId.slice(0, 8)}</span>
        <span>{t(`mcp.applyStates.${application.state}`)}</span>
        {application.error && <span className="text-destructive">{application.error}</span>}
        {application.state === 'failed' && <button className={buttonClass} disabled={Boolean(busy)} onClick={() => { void run(application.sessionId, async () => { await mcpRequest(`/applications/${application.sessionId}/retry`, 'POST'); await loadApplications() }) }}>{t('mcp.retry')}</button>}
      </div>)}
    </div>}
  </section>
})
export default McpSettingsPage
