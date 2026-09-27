---
module: todos
tags: [ui, todos, detail-panel, workspace, markdown]
problem_type: feature-plan
---

# TodoDetail panel enhancements

## Goal

Enhance the `TodoDetail` side panel so it is easier to read and edit the selected todo, while staying consistent with the rest of the Todos panel top-bar redesign.

## Scope

1. **Wider, resizable, animated detail panel**
   - Default width: 384 px (`w-96`).
   - Add a left-edge drag handle to resize between 260 px and 520 px.
   - Animate the panel in when a todo is selected and out when deselected using CSS transitions keyed on `data-visible`.
   - Persist the width in component-local state for the lifetime of the panel.

2. **Workspace name + selector**
   - Look up the workspace name from `useWorkspaceStore` instead of rendering `workspaceId`.
   - Provide a native `<select>` (consistent with the existing spawn workspace picker) to reassign the todo to another workspace; wire to `updateTodo(todo.id, { workspaceId })`.
   - Show "No workspace" when unassigned.

3. **Editable status**
   - Replace the read-only status field with a `<select>` that offers all `TodoStatus` values.
   - On change, call `changeStatus(todo.id, newStatus)`.

4. **Todo content / detail editing**
   - Add a markdown body field (`todo.text`).
   - Provide a small tab-like toggle between **Edit** (CodeMirror) and **Preview** (MarkdownPreview).
   - Auto-save on blur / 800 ms debounce via `updateTodo(todo.id, { text })`.
   - Empty state: when `text` is empty, show a placeholder prompt and focus the editor.

## Files to change

- `src/client/components/todos/TodoDetail.tsx` — main implementation.
- `src/client/components/TodosPanel.tsx` — pass `updateTodo`/`changeStatus` and lift the resizable width state.
- `src/client/components/todos/TodoDetail.test.tsx` — new tests.
- `src/client/i18n/en/todos.json` and `zh-CN/todos.json` — new keys.

## New i18n keys (en)

- `detailWorkspacePlaceholder` — "Select workspace…"
- `detailStatusPlaceholder` — "Select status…`
- `detailBody` — "Details"
- `edit` — "Edit"
- `preview` — "Preview"
- `noBody` — "No details yet. Click Edit to add notes."

## Tests to add

- Panel renders wider than 288 px and contains a resize handle.
- Selecting/deselecting todo triggers animation class changes.
- Workspace name is shown; changing workspace selector calls `updateTodo` with new `workspaceId`.
- Status selector calls `changeStatus`.
- Edit/preview toggle and editor blur update todo text via `updateTodo`.

## Open questions / notes

- CodeMirrorEditor requires a `language` extension; use `getCodeMirrorLanguage('.md')` for markdown.
- `MarkdownPreview` is already available and safe for streamed/sanitized content.
- Keep the existing `ConflictReview` and "Start session" sections intact.
