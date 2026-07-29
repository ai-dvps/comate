import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import MarkdownPreview from '../MarkdownPreview';
import { cn } from '../ui/utils';

interface Conflict {
  field: 'title' | 'body';
  localValue: string;
  remoteValue: string;
  baselineValue: string | null;
}

interface ConflictReviewProps {
  todoId: string;
  /** Called after a resolution so the parent can refresh the todo. */
  onResolved: () => void;
}

/**
 * Accept-local / accept-remote UI for structural-field conflicts (R11/AE3).
 * The detail pane shows this only when the todo has unresolved conflicts; both
 * sides are shown so no edit is silently lost. Choosing one applies it, resets
 * the baseline, and clears the conflict.
 */
export default function ConflictReview({ todoId, onResolved }: ConflictReviewProps) {
  const { t } = useTranslation('todos');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/todos/${todoId}/conflicts`)
      .then((r) => r.json())
      .then((data: { conflicts?: Conflict[] }) => {
        if (active) setConflicts(data.conflicts ?? []);
      })
      .catch(() => {
        if (active) setConflicts([]);
      });
    return () => {
      active = false;
    };
  }, [todoId]);

  const resolve = async (field: 'title' | 'body', choice: 'local' | 'remote') => {
    setBusy(true);
    try {
      const res = await fetch(`/api/todos/${todoId}/conflicts/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, choice }),
      });
      if (res.ok) {
        setConflicts((prev) => prev.filter((c) => c.field !== field));
        onResolved();
      }
    } finally {
      setBusy(false);
    }
  };

  if (conflicts.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border border-yellow-500/40 bg-yellow-500/5 rounded-md p-3">
      <p className="text-xs font-medium text-yellow-600 dark:text-yellow-400">{t('conflictTitle')}</p>
      {conflicts.map((c) => {
        // Body values are markdown (R2): render them formatted via the markdown
        // previewer instead of the plain mono span used for titles, and cap the
        // height so a very long body (up to ~50k chars) can't blow out the panel.
        const isBody = c.field === 'body';
        const sideClass = cn(
          'text-left text-xs px-2 py-1 rounded border border-border bg-bg hover:bg-surface-hover disabled:opacity-50',
          isBody ? 'flex flex-col items-stretch gap-1' : 'flex items-center gap-1.5',
        );
        const renderSide = (choice: 'local' | 'remote', value: string) => {
          const label = choice === 'local' ? t('conflictAcceptLocal') : t('conflictAcceptRemote');
          const icon =
            busy && choice === 'remote' ? (
              <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
            ) : (
              <Check className="w-3 h-3 flex-shrink-0" />
            );
          if (isBody) {
            return (
              <>
                <span className="flex items-center gap-1.5">
                  {icon}
                  <span className="text-text-tertiary">{label}:</span>
                </span>
                <div className="max-h-64 overflow-auto rounded bg-surface-hover/40">
                  <MarkdownPreview content={value} className="px-3 py-2" />
                </div>
              </>
            );
          }
          return (
            <>
              {icon}
              <span className="text-text-tertiary">{label}:</span>
              <span className="font-mono text-text-primary break-all">{value}</span>
            </>
          );
        };
        return (
          <div key={c.field} className="flex flex-col gap-1.5">
            <p className="text-[11px] text-text-tertiary">{isBody ? t('conflictFieldBody') : t('conflictFieldTitle')}</p>
            <div className="flex flex-col gap-1">
              <button onClick={() => resolve(c.field, 'local')} disabled={busy} className={sideClass}>
                {renderSide('local', c.localValue)}
              </button>
              <button onClick={() => resolve(c.field, 'remote')} disabled={busy} className={sideClass}>
                {renderSide('remote', c.remoteValue)}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
