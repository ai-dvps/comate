import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Github, Loader2, X, ExternalLink, Copy, Check, Unplug } from 'lucide-react';
import { useGithubStore, type DeviceFlowStart } from '../../stores/github-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { cn } from '../ui/utils';

interface GitHubConnectProps {
  onClose: () => void;
}

export default function GitHubConnect({ onClose }: GitHubConnectProps) {
  const { t } = useTranslation('todos');
  const {
    connection,
    repos,
    isBusy,
    error,
    workspaceRepos,
    fetchStatus,
    startDeviceFlow,
    pollDeviceFlow,
    connectPat,
    disconnect,
    fetchRepos,
    fetchWorkspaceRepos,
    setWorkspaceRepos,
    clearError,
  } = useGithubStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();

  const [mode, setMode] = useState<'device' | 'pat'>('device');
  const [device, setDevice] = useState<DeviceFlowStart | null>(null);
  const [pat, setPat] = useState('');
  const [copied, setCopied] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);

  // The workspace whose repo association is being configured (default: active).
  const [assocWorkspaceId, setAssocWorkspaceId] = useState<string | null>(activeWorkspaceId);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Load accessible repos + the active workspace's association once connected.
  useEffect(() => {
    if (connection?.connected) {
      if (repos.length === 0) fetchRepos();
      const wsId = assocWorkspaceId ?? activeWorkspaceId;
      if (wsId && !workspaceRepos[wsId]) fetchWorkspaceRepos(wsId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.connected]);

  // Device Flow polling loop.
  useEffect(() => {
    if (!device) return;
    let active = true;
    const interval = setInterval(async () => {
      try {
        const result = await pollDeviceFlow();
        if (!active) return;
        if (result.status === 'success') {
          setDevice(null);
          clearError();
        } else if (result.status === 'expired' || result.status === 'access_denied' || result.status === 'incorrect_device_code') {
          setDevice(null);
        }
        // 'pending' / 'slow_down' → keep polling
      } catch {
        if (active) setDevice(null);
      }
    }, (device.interval || 5) * 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [device, pollDeviceFlow, clearError]);

  const handleStart = async () => {
    try {
      const start = await startDeviceFlow();
      setDevice(start);
    } catch {
      /* error surfaced via store */
    }
  };

  const handlePat = async () => {
    if (!pat.trim()) return;
    await connectPat(pat.trim());
    setPat('');
  };

  const handleDisconnect = async () => {
    const result = await disconnect();
    if (result?.deepLink) setDeepLink(result.deepLink);
  };

  const copyUserCode = () => {
    if (!device) return;
    void navigator.clipboard.writeText(device.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const connected = !!connection?.connected;
  const assocRepos = assocWorkspaceId ? workspaceRepos[assocWorkspaceId] ?? [] : [];
  const assocWs = workspaces.find((w) => w.id === assocWorkspaceId) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-bg border border-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 h-12 border-b border-border sticky top-0 bg-bg">
          <Github className="w-4 h-4 text-text-primary" />
          <h2 className="text-sm font-semibold text-text-primary flex-1">{t('ghTitle')}</h2>
          <button onClick={onClose} className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover" aria-label={t('close')}>
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 flex flex-col gap-3">
          {error && (
            <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5">{error}</p>
          )}

          {!connected ? (
            <>
              <div className="flex gap-1 p-0.5 bg-surface rounded-md self-start">
                <button
                  onClick={() => setMode('device')}
                  className={cn('px-3 py-1 text-xs rounded', mode === 'device' ? 'bg-bg text-text-primary shadow-sm' : 'text-text-tertiary')}
                >
                  {t('ghDeviceFlow')}
                </button>
                <button
                  onClick={() => setMode('pat')}
                  className={cn('px-3 py-1 text-xs rounded', mode === 'pat' ? 'bg-bg text-text-primary shadow-sm' : 'text-text-tertiary')}
                >
                  {t('ghPat')}
                </button>
              </div>

              {mode === 'device' ? (
                <div className="flex flex-col gap-3">
                  {!device ? (
                    <>
                      <p className="text-sm text-text-secondary">{t('ghDeviceDesc')}</p>
                      <button
                        onClick={handleStart}
                        disabled={isBusy}
                        className="self-start flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 text-sm"
                      >
                        {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                        {t('ghStart')}
                      </button>
                    </>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm text-text-secondary">{t('ghEnterCode')}</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 font-mono text-lg tracking-widest bg-surface text-text-primary rounded px-3 py-2 border border-border">
                          {device.userCode}
                        </code>
                        <button
                          onClick={copyUserCode}
                          className="p-2 rounded-md border border-border text-text-secondary hover:bg-surface-hover"
                          aria-label={t('ghCopy')}
                        >
                          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                      <a
                        href={device.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                        className="self-start flex items-center gap-1.5 text-sm text-accent hover:underline"
                      >
                        {device.verificationUri}
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <div className="flex items-center gap-2 text-xs text-text-tertiary">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {t('ghWaiting')}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-text-secondary">{t('ghPatDesc')}</p>
                  <input
                    type="password"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    placeholder={t('ghPatPlaceholder')}
                    className="w-full bg-surface text-text-primary text-sm rounded-md px-2.5 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <button
                    onClick={handlePat}
                    disabled={isBusy || !pat.trim()}
                    className="self-start flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 text-sm"
                  >
                    {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                    {t('ghPatConnect')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Connected view */}
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Check className="w-4 h-4 text-green-500" />
                <span>
                  {t('ghConnectedAs', { type: connection?.tokenType === 'pat' ? 'PAT' : 'GitHub App' })}
                </span>
                {connection?.expiresAt && (
                  <span className="text-xs text-text-tertiary">
                    {t('ghExpires', { at: new Date(connection.expiresAt).toLocaleString() })}
                  </span>
                )}
              </div>

              {deepLink && (
                <p className="text-xs text-text-secondary bg-surface rounded px-2 py-1.5">
                  {t('ghManualRevoke')}{' '}
                  <a href={deepLink} target="_blank" rel="noreferrer" className="text-accent hover:underline inline-flex items-center gap-1">
                    {deepLink} <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              )}

              {/* Workspace repo association */}
              {workspaces.length > 0 && (
                <WorkspaceRepoAssociation
                  workspaces={workspaces}
                  selectedId={assocWorkspaceId}
                  onSelect={setAssocWorkspaceId}
                  onLoad={(id) => fetchWorkspaceRepos(id)}
                  selectedWorkspace={assocWs}
                  repos={repos}
                  associated={assocRepos}
                  onToggle={(fullName) => {
                    if (!assocWorkspaceId) return;
                    const next = assocRepos.includes(fullName)
                      ? assocRepos.filter((r) => r !== fullName)
                      : [...assocRepos, fullName];
                    void setWorkspaceRepos(assocWorkspaceId, next);
                  }}
                />
              )}

              <button
                onClick={handleDisconnect}
                disabled={isBusy}
                className="self-start flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-50 text-sm"
              >
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unplug className="w-4 h-4" />}
                {t('ghDisconnect')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceRepoAssociation({
  workspaces,
  selectedId,
  onSelect,
  onLoad,
  selectedWorkspace,
  repos,
  associated,
  onToggle,
}: {
  workspaces: { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoad: (id: string) => void;
  selectedWorkspace: { id: string; name: string } | null;
  repos: { fullName: string; private: boolean }[];
  associated: string[];
  onToggle: (fullName: string) => void;
}) {
  const { t } = useTranslation('todos');
  const [showPrivate, setShowPrivate] = useState(false);

  // Load the selected workspace's association whenever it changes.
  useEffect(() => {
    if (selectedId) onLoad(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Private repo names are hidden by default (R17) unless the user opts in.
  const visible = repos.filter((r) => showPrivate || !r.private);

  return (
    <div className="flex flex-col gap-2 border border-border rounded-md p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-text-secondary flex-1">{t('ghReposFor')}</span>
        <select
          value={selectedId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          className="bg-surface text-text-primary text-xs rounded px-1.5 py-1 border border-border focus:outline-none"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {selectedWorkspace ? (
        repos.length === 0 ? (
          <p className="text-xs text-text-tertiary">{t('ghNoRepos')}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
              {visible.map((r) => {
                const checked = associated.includes(r.fullName);
                return (
                  <li key={r.fullName}>
                    <label className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-surface-hover cursor-pointer">
                      <input type="checkbox" checked={checked} onChange={() => onToggle(r.fullName)} className="accent-accent" />
                      <span className="text-xs text-text-primary flex-1">{r.fullName}</span>
                      {r.private && <span className="text-[10px] text-text-tertiary">{t('ghPrivate')}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            {repos.some((r) => r.private) && (
              <label className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <input type="checkbox" checked={showPrivate} onChange={(e) => setShowPrivate(e.target.checked)} className="accent-accent" />
                {t('ghShowPrivate')}
              </label>
            )}
          </>
        )
      ) : (
        <p className="text-xs text-text-tertiary">{t('ghNoWorkspace')}</p>
      )}
    </div>
  );
}
