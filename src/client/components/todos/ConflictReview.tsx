import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';

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
      {conflicts.map((c) => (
        <div key={c.field} className="flex flex-col gap-1.5">
          <p className="text-[11px] text-text-tertiary">{c.field === 'title' ? t('conflictFieldTitle') : t('conflictFieldBody')}</p>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => resolve(c.field, 'local')}
              disabled={busy}
              className="flex items-center gap-1.5 text-left text-xs px-2 py-1 rounded border border-border bg-bg hover:bg-surface-hover disabled:opacity-50"
            >
              <Check className="w-3 h-3 flex-shrink-0" />
              <span className="text-text-tertiary">{t('conflictAcceptLocal')}:</span>
              <span className="font-mono text-text-primary break-all">{c.localValue}</span>
            </button>
            <button
              onClick={() => resolve(c.field, 'remote')}
              disabled={busy}
              className="flex items-center gap-1.5 text-left text-xs px-2 py-1 rounded border border-border bg-bg hover:bg-surface-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" /> : <Check className="w-3 h-3 flex-shrink-0" />}
              <span className="text-text-tertiary">{t('conflictAcceptRemote')}:</span>
              <span className="font-mono text-text-primary break-all">{c.remoteValue}</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
