import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTodoStore, type Todo, type TodoStatus } from '../stores/todo-store';
import { useChatStore } from '../stores/chat-store';
import {
  Search,
  Plus,
  Link as LinkIcon,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Circle,
  ExternalLink,
} from 'lucide-react';

interface TodoListProps {
  workspaceId: string;
  onSessionNavigate?: () => void;
}

const statusConfig: Record<TodoStatus, { label: string; icon: typeof Circle; color: string; bg: string }> = {
  pending: {
    label: 'Pending',
    icon: Circle,
    color: 'text-text-tertiary',
    bg: 'bg-text-tertiary/10',
  },
  done: {
    label: 'Done',
    icon: CheckCircle2,
    color: 'text-green-500',
    bg: 'bg-green-500/10',
  },
  discard: {
    label: 'Discard',
    icon: XCircle,
    color: 'text-red-400',
    bg: 'bg-red-400/10',
  },
  'did-but-need-verify': {
    label: 'Verify',
    icon: AlertCircle,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
  },
};

export default function TodoList({ workspaceId, onSessionNavigate }: TodoListProps) {
  const { t } = useTranslation('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const [quickAddText, setQuickAddText] = useState('');
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<'text' | 'detail' | null>(null);
  const [editText, setEditText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; todoId: string } | null>(null);
  const [statusMenuTodoId, setStatusMenuTodoId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const todos = useTodoStore((s) => s.todosByWorkspace[workspaceId] || []);
  const isLoading = useTodoStore((s) => s.isLoading[workspaceId]);
  const fetchTodos = useTodoStore((s) => s.fetchTodos);
  const createTodo = useTodoStore((s) => s.createTodo);
  const updateTodo = useTodoStore((s) => s.updateTodo);
  const deleteTodo = useTodoStore((s) => s.deleteTodo);
  const changeStatus = useTodoStore((s) => s.changeStatus);
  const setActiveSession = useChatStore((s) => s.setActiveSession);

  useEffect(() => {
    if (workspaceId) {
      fetchTodos(workspaceId);
    }
  }, [workspaceId, fetchTodos]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  const handleQuickAdd = async () => {
    const text = quickAddText.trim();
    if (!text) return;
    await createTodo(workspaceId, text);
    setQuickAddText('');
  };

  const startEdit = (todo: Todo, field: 'text' | 'detail') => {
    setEditingTodoId(todo.id);
    setEditingField(field);
    setEditText(field === 'text' ? todo.text : todo.detail);
  };

  const commitEdit = async (todoId: string) => {
    const trimmed = editText.trim();
    if (trimmed && editingField) {
      await updateTodo(todoId, { [editingField]: trimmed });
    }
    setEditingTodoId(null);
    setEditingField(null);
    setEditText('');
  };

  const cancelEdit = () => {
    setEditingTodoId(null);
    setEditingField(null);
    setEditText('');
  };

  const handleDelete = async (todoId: string) => {
    await deleteTodo(todoId);
    setContextMenu(null);
  };

  const handleStartSession = async (todo: Todo) => {
    if (!todo.sessionId) {
      const confirmed = window.confirm(
        t('startSessionConfirm', { name: todo.text, defaultValue: `Start a new session named "${todo.text}"?` })
      );
      if (!confirmed) return;

      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/todos/${todo.id}/session`, {
          method: 'POST',
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create session');
        }
        const session = await res.json();
        // Pre-fill draft if detail exists
        if (todo.detail) {
          useChatStore.getState().setDraft(session.id, todo.detail);
        }
        // Switch to sessions tab and activate the new session
        setActiveSession(workspaceId, session.id);
        onSessionNavigate?.();
        // Refresh todos to show link
        fetchTodos(workspaceId);
      } catch (err) {
        console.error('Failed to create session from todo:', err);
        alert(err instanceof Error ? err.message : 'Failed to create session');
      }
    } else {
      // Navigate to linked session
      setActiveSession(workspaceId, todo.sessionId);
      onSessionNavigate?.();
    }
  };

  const filteredTodos = todos.filter((todo) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return todo.text.toLowerCase().includes(q) || todo.detail.toLowerCase().includes(q);
  });

  const navigateToSession = useCallback((sessionId: string) => {
    setActiveSession(workspaceId, sessionId);
    onSessionNavigate?.();
  }, [workspaceId, setActiveSession, onSessionNavigate]);

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchTodos', { defaultValue: 'Search todos...' })}
            className="w-full pl-8 pr-3 py-2 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
        </div>
      </div>

      {/* Todo List */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && todos.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">{t('loadingTodos', { defaultValue: 'Loading todos...' })}</div>
        ) : filteredTodos.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary text-center">
            {searchQuery ? t('noSearchResults', { defaultValue: 'No todos match your search.' }) : (
              <>
                {t('noTodos', { defaultValue: 'No todos yet.' })}
                <br />
                {t('createTodoPrompt', { defaultValue: 'Create one below.' })}
              </>
            )}
          </div>
        ) : (
          filteredTodos.map((todo) => {
            const isEditing = editingTodoId === todo.id;
            const status = statusConfig[todo.status];
            const StatusIcon = status.icon;
            const isLinked = !!todo.sessionId;
            const isDoneOrDiscard = todo.status === 'done' || todo.status === 'discard';

            return (
              <div
                key={todo.id}
                className={`mx-2 px-3 py-2.5 rounded-lg group transition-all ${
                  isDoneOrDiscard ? 'opacity-60' : ''
                } hover:bg-surface-hover`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, todoId: todo.id });
                }}
              >
                <div className="flex items-start gap-2">
                  {/* Status indicator */}
                  <button
                    onClick={() => setStatusMenuTodoId(statusMenuTodoId === todo.id ? null : todo.id)}
                    className={`mt-0.5 p-0.5 rounded flex-shrink-0 ${status.bg} ${status.color} hover:opacity-80 transition-opacity`}
                    title={status.label}
                  >
                    <StatusIcon className="w-3.5 h-3.5" />
                  </button>

                  {/* Status dropdown */}
                  {statusMenuTodoId === todo.id && (
                    <div className="absolute z-50 mt-5 ml-0 min-w-[120px] bg-surface-active border border-border rounded-lg shadow-lg py-1">
                      {(Object.keys(statusConfig) as TodoStatus[]).map((s) => {
                        const cfg = statusConfig[s];
                        const Icon = cfg.icon;
                        return (
                          <button
                            key={s}
                            onClick={() => {
                              changeStatus(todo.id, s);
                              setStatusMenuTodoId(null);
                            }}
                            className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-surface-hover transition-colors ${
                              todo.status === s ? 'text-text-primary font-medium' : 'text-text-secondary'
                            }`}
                          >
                            <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                            {cfg.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    {/* Text */}
                    {isEditing && editingField === 'text' ? (
                      <input
                        autoFocus
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitEdit(todo.id);
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        onBlur={() => commitEdit(todo.id)}
                        className="w-full px-2 py-0.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary"
                      />
                    ) : (
                      <p
                        onClick={() => startEdit(todo, 'text')}
                        className={`text-xs truncate cursor-text ${
                          isDoneOrDiscard ? 'line-through text-text-tertiary' : 'text-text-primary'
                        }`}
                      >
                        {todo.text}
                      </p>
                    )}

                    {/* Detail */}
                    {todo.detail && (
                      <>
                        {isEditing && editingField === 'detail' ? (
                          <input
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitEdit(todo.id);
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                            onBlur={() => commitEdit(todo.id)}
                            className="w-full mt-1 px-2 py-0.5 text-[11px] bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-secondary"
                          />
                        ) : (
                          <p
                            onClick={() => startEdit(todo, 'detail')}
                            className="text-[11px] text-text-tertiary truncate mt-0.5 cursor-text hover:text-text-secondary transition-colors"
                          >
                            {todo.detail}
                          </p>
                        )}
                      </>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-1.5">
                      {isLinked ? (
                        <button
                          onClick={() => navigateToSession(todo.sessionId!)}
                          className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover transition-colors"
                          title={t('goToSession', { defaultValue: 'Go to session' })}
                        >
                          <LinkIcon className="w-3 h-3" />
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      ) : todo.status === 'pending' ? (
                        <button
                          onClick={() => handleStartSession(todo)}
                          className="text-[10px] text-accent hover:text-accent-hover transition-colors"
                        >
                          {t('startSession', { defaultValue: 'Start session' })}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* Delete button (visible on hover) */}
                  <button
                    onClick={() => handleDelete(todo.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 transition-all flex-shrink-0"
                    title={t('deleteTodo', { defaultValue: 'Delete todo' })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Quick Add */}
      <div className="p-3 border-t border-border/50">
        <div className="flex gap-2">
          <input
            value={quickAddText}
            onChange={(e) => setQuickAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleQuickAdd();
            }}
            placeholder={t('newTodoPlaceholder', { defaultValue: 'Add a todo...' })}
            className="flex-1 px-3 py-2 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <button
            onClick={handleQuickAdd}
            disabled={!quickAddText.trim()}
            className="px-3 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-accent-foreground rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        (() => {
          const todo = todos.find((t) => t.id === contextMenu.todoId);
          if (!todo) return null;
          return (
            <div
              className="fixed z-50 min-w-[160px] bg-surface-active border border-border rounded-lg shadow-lg py-1"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  startEdit(todo, 'text');
                  setContextMenu(null);
                }}
                className="w-full px-3 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover transition-colors"
              >
                {t('edit', { defaultValue: 'Edit' })}
              </button>
              <button
                onClick={() => handleDelete(todo.id)}
                className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              >
                {t('delete', { defaultValue: 'Delete' })}
              </button>
            </div>
          );
        })()
      )}
    </div>
  );
}
