import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWeComQueueStore, type ProactiveMessageStatus } from '../stores/wecom-queue-store';
import {
  RefreshCw,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Send,
} from 'lucide-react';

const EMPTY_ARRAY: [] = [];

interface WeComQueuePanelProps {
  workspaceId: string;
}

const statusConfig: Record<ProactiveMessageStatus, { label: string; icon: typeof Clock; color: string; bg: string }> = {
  pending: {
    label: 'Pending',
    icon: Clock,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
  },
  delivering: {
    label: 'Delivering',
    icon: Loader2,
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
  },
  delivered: {
    label: 'Delivered',
    icon: CheckCircle2,
    color: 'text-green-500',
    bg: 'bg-green-500/10',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    color: 'text-red-400',
    bg: 'bg-red-400/10',
  },
};

export default function WeComQueuePanel({ workspaceId }: WeComQueuePanelProps) {
  const { t } = useTranslation('chat');
  const [isRetrying, setIsRetrying] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState<Set<string>>(new Set());

  const entries = useWeComQueueStore((s) => s.entriesByWorkspace[workspaceId] ?? EMPTY_ARRAY);
  const isLoading = useWeComQueueStore((s) => s.isLoading[workspaceId]);
  const error = useWeComQueueStore((s) => s.error[workspaceId]);
  const statusFilter = useWeComQueueStore((s) => s.statusFilter);
  const fetchEntries = useWeComQueueStore((s) => s.fetchEntries);
  const retryEntry = useWeComQueueStore((s) => s.retryEntry);
  const deleteEntry = useWeComQueueStore((s) => s.deleteEntry);
  const setStatusFilter = useWeComQueueStore((s) => s.setStatusFilter);

  useEffect(() => {
    if (workspaceId) {
      fetchEntries(workspaceId);
    }
  }, [workspaceId, statusFilter, fetchEntries]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (!workspaceId) return;
    const timer = setInterval(() => {
      fetchEntries(workspaceId);
    }, 5000);
    return () => clearInterval(timer);
  }, [workspaceId, fetchEntries]);

  const handleRetry = async (entryId: string) => {
    setIsRetrying((prev) => new Set(prev).add(entryId));
    await retryEntry(workspaceId, entryId);
    setIsRetrying((prev) => {
      const next = new Set(prev);
      next.delete(entryId);
      return next;
    });
  };

  const handleDelete = async (entryId: string) => {
    setIsDeleting((prev) => new Set(prev).add(entryId));
    await deleteEntry(workspaceId, entryId);
    setIsDeleting((prev) => {
      const next = new Set(prev);
      next.delete(entryId);
      return next;
    });
  };

  const filteredEntries = statusFilter
    ? entries.filter((e) => e.status === statusFilter)
    : entries;

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with filter */}
      <div className="p-3 pb-2 flex items-center gap-2">
        <select
          value={statusFilter || ''}
          onChange={(e) => setStatusFilter(e.target.value || null)}
          className="flex-1 px-3 py-2 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary"
        >
          <option value="">{t('allStatuses', { defaultValue: 'All statuses' })}</option>
          {(Object.keys(statusConfig) as ProactiveMessageStatus[]).map((s) => (
            <option key={s} value={s}>
              {statusConfig[s].label}
            </option>
          ))}
        </select>
        <button
          onClick={() => fetchEntries(workspaceId)}
          className="p-2 rounded-lg bg-bg border border-border hover:bg-surface-hover text-text-secondary transition-colors"
          title={t('refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-3 mb-2 px-3 py-2 text-xs bg-red-500/10 text-red-400 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Queue list */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && entries.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">
            {t('loadingQueue', { defaultValue: 'Loading queue...' })}
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary text-center">
            {statusFilter
              ? t('noEntriesForFilter', { defaultValue: 'No entries match the selected filter.' })
              : t('noQueueEntries', { defaultValue: 'No proactive messages in queue.' })}
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const status = statusConfig[entry.status];
            const StatusIcon = status.icon;
            const canRetry = entry.status === 'failed' || entry.status === 'pending';
            const isDelivering = entry.status === 'delivering';

            return (
              <div
                key={entry.id}
                className="mx-2 px-3 py-2.5 rounded-lg hover:bg-surface-hover transition-all"
              >
                <div className="flex items-start gap-2">
                  {/* Status badge */}
                  <div
                    className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 flex-shrink-0 ${status.bg} ${status.color}`}
                  >
                    <StatusIcon className={`w-3 h-3 ${isDelivering ? 'animate-spin' : ''}`} />
                    {status.label}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Recipient and content */}
                    <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                      <Send className="w-3 h-3" />
                      <span className="font-medium text-text-primary">{entry.recipientPlaintextUserId}</span>
                      <span className="text-text-tertiary">·</span>
                      <span className="truncate">{entry.senderSessionId.slice(0, 8)}...</span>
                    </div>

                    {/* Message preview */}
                    <p className="text-xs text-text-primary mt-1 truncate">
                      {entry.messageContent}
                    </p>

                    {/* Created time and error */}
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-text-tertiary">
                      <span>{formatTime(entry.createdAt)}</span>
                      {entry.retryCount > 0 && (
                        <span className="text-amber-400">
                          {t('retryCount', { count: entry.retryCount, defaultValue: `Retry ${entry.retryCount}` })}
                        </span>
                      )}
                    </div>
                    {entry.errorReason && (
                      <p className="text-[10px] text-red-400 mt-0.5 truncate" title={entry.errorReason}>
                        {entry.errorReason}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {canRetry && (
                      <button
                        onClick={() => handleRetry(entry.id)}
                        disabled={isRetrying.has(entry.id)}
                        className="p-1.5 rounded hover:bg-accent/10 text-text-tertiary hover:text-accent transition-colors disabled:opacity-50"
                        title={t('retry', { defaultValue: 'Retry' })}
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isRetrying.has(entry.id) ? 'animate-spin' : ''}`} />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(entry.id)}
                      disabled={isDeleting.has(entry.id)}
                      className="p-1.5 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 transition-colors disabled:opacity-50"
                      title={t('delete', { defaultValue: 'Delete' })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
