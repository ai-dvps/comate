# Plan: Add Compact Visibility to Comate Client

## Problem Frame

When Claude Code compacts a conversation (via `/compact` or auto-compact), the comate GUI client gives no visual indication that compaction is happening or has happened. In the Claude Code CLI, users see:

1. A **"Compacting conversation"** spinner while compaction is in progress
2. A **"✻ Conversation compacted"** boundary marker after compaction completes

In comate, both signals are silently lost because `SseEmitter.handle()` drops all system messages except `init` and task-related subtypes. The SDK emits:

- `SDKStatusMessage` (`subtype: 'status'`, `status: 'compacting'`) during compaction
- `SDKCompactBoundaryMessage` (`subtype: 'compact_boundary'`) after compaction

Both are discarded by the current SSE emitter.

## Scope

**In scope:**
- Detect `compact_boundary` and `status: 'compacting'` SDK system messages on the server
- Emit new SSE events for both signals
- Extend shared message types (`SseEvent`, `ChatMessage`)
- Handle new events in the client chat store
- Render a compact boundary separator in the message list
- Render a transient "Compacting…" indicator during active compaction
- Preserve compact boundaries when loading historical session messages

**Out of scope:**
- Modifying Claude Code source (the detailed `CompactProgressEvent` phases — `hooks_start`, `compact_start`, `compact_end` — are internal Claude Code callbacks, not SDK messages; we cannot access them)
- Numeric X/Y progress (the SDK provides no predicted total steps)
- Partial compaction message selector UI
- Compacting indicator for session-memory or reactive compact paths that emit no status events

## Requirements

| ID | Requirement |
|---|---|
| R1 | When the SDK emits `status: 'compacting'`, the client MUST show a visual indicator that compaction is in progress |
| R2 | When compaction completes, the client MUST display a boundary marker at the point in the transcript where compaction occurred |
| R3 | The boundary marker MUST be distinguishable from error system messages (no red destructive styling) |
| R4 | Loading historical messages for a session MUST preserve compact boundary markers |
| R5 | The two `src/client/types/message.ts` and `src/server/types/message.ts` files MUST remain byte-identical |

## Key Decisions

### D1: Named phase labels over numeric progress

A true percentage or X/Y step counter is infeasible because:
- Summary generation is a black-box API call with no predicted output size
- Different compact paths (traditional, reactive, session-memory) emit different progress events
- The only SDK-visible signal is `status: 'compacting'` (on/off) plus the final boundary

**Decision:** Show a binary "Compacting…" indicator rather than over-promising granular progress. (see origin: squishy-beaming-wand.md)

### D2: Extend `ChatMessage` with `isCompactBoundary` rather than a new `MessagePart` variant

Adding a `compact_boundary` part type would require updating `MessagePart` union consumers (normalizer, store, renderers). An optional boolean flag on `ChatMessage` is additive, has no effect on existing code paths, and makes the rendering intent explicit without changing the part grammar.

### D3: Use `system` role for boundary messages

The compact boundary is not a user or assistant utterance; `system` role is the closest fit. The existing `MessageList.tsx` already handles `system` role messages — we just branch the rendering when `isCompactBoundary` is true.

### D4: Clear `isCompacting` on `assistant_start` as a fallback

The SDK may not reliably emit `status: null` when compaction ends. If the client misses the off signal, the indicator would stick forever. Clearing `isCompacting` when a new `assistant_start` arrives (i.e., the model resumes responding) is a safe, conservative fallback.

## Implementation Units

### U1: Server-side compact event detection

**Files:** `src/server/services/sse-emitter.ts`

**Change:** In `SseEmitter.handle()`, inside the `case 'system':` block (after the existing `task_notification` handler), add two new subtype handlers:

1. `compact_boundary`:
   ```typescript
   if (msg.subtype === 'compact_boundary') {
     this.send({ type: 'compact_boundary' });
     return;
   }
   ```

2. `status`:
   ```typescript
   if (msg.subtype === 'status') {
     const statusMsg = msg as Record<string, unknown>;
     const status = statusMsg.status;
     if (status === 'compacting') {
       this.send({ type: 'compact_status', active: true });
     } else if (status === null) {
       this.send({ type: 'compact_status', active: false });
     }
     return;
   }
   ```

Place both before the final `return;` that currently drops all unrecognized system messages.

### U2: Extend shared message types

**Files:** `src/client/types/message.ts`, `src/server/types/message.ts` (must be byte-identical)

**Changes:**

1. Add two new variants to the `SseEvent` discriminated union:
   ```typescript
   | { type: 'compact_boundary' }
   | { type: 'compact_status'; active: boolean }
   ```

2. Add an optional field to `ChatMessage`:
   ```typescript
   export interface ChatMessage {
     id: string
     role: MessageRole
     parts: MessagePart[]
     timestamp: number
     isStreaming?: boolean
     isCompactBoundary?: boolean
   }
   ```

**Verification:** Run `diff src/client/types/message.ts src/server/types/message.ts` and confirm zero output.

### U3: Chat store handling

**File:** `src/client/stores/chat-store.ts`

**Changes:**

1. Add `isCompacting` to `ChatState`:
   ```typescript
   isCompacting: Record<string, boolean>
   ```

2. In the store's initial state, add `isCompacting: {}`.

3. In `handleSseEvent`, add two new cases:

   - `compact_boundary`:
     ```typescript
     case 'compact_boundary': {
       set((state) => ({
         ...addSystemMessage(state, sessionId, 'Conversation compacted'),
         isCompacting: {
           ...state.isCompacting,
           [sessionId]: false,
         },
       }))
       // Tag the just-added message as a boundary
       set((state) => {
         const messages = state.messages[sessionId] || []
         const lastMessage = messages[messages.length - 1]
         if (lastMessage && lastMessage.role === 'system') {
           return {
             messages: {
               ...state.messages,
               [sessionId]: messages.map((m, idx) =>
                 idx === messages.length - 1
                   ? { ...m, isCompactBoundary: true }
                   : m
               ),
             },
           }
         }
         return {}
       })
       return
     }
     ```

   - `compact_status`:
     ```typescript
     case 'compact_status': {
       const active = data.active === true
       set((state) => ({
         isCompacting: { ...state.isCompacting, [sessionId]: active },
       }))
       return
     }
     ```

4. In the existing `assistant_start` handler, clear `isCompacting` as a safety net:
   ```typescript
   // inside case 'assistant_start':
   const updates: Partial<ChatState> = {
     // existing updates...
   }
   if (state.isCompacting[sessionId]) {
     updates.isCompacting = { ...state.isCompacting, [sessionId]: false }
   }
   return updates
   ```

### U4: Historical message normalization

**File:** `src/server/services/message-normalizer.ts`

**Change:** Update `normalizeSessionMessage` to preserve `compact_boundary` system messages from historical session data.

1. Modify `roleFromType` to return `'system'` instead of `null` for system messages:
   ```typescript
   function roleFromType(type: SessionMessage['type']): MessageRole | null {
     if (type === 'user') return 'user'
     if (type === 'assistant') return 'assistant'
     if (type === 'system') return 'system'
     return null
   }
   ```

2. After computing `parts`, check if this is a compact boundary:
   ```typescript
   const rawMessage = sessionMessage.message as Record<string, unknown> | undefined
   const subtype = typeof rawMessage?.subtype === 'string' ? rawMessage.subtype : ''
   const isCompactBoundary = subtype === 'compact_boundary'

   if (parts.length === 0 && !isCompactBoundary) {
     return null
   }
   ```

3. Include `isCompactBoundary` in the returned `ChatMessage`:
   ```typescript
   return {
     id: sessionMessage.uuid,
     role,
     parts: parts.length > 0 ? parts : [{ type: 'text', text: 'Conversation compacted' }],
     timestamp: Date.now(),
     isCompactBoundary,
   }
   ```

**Note:** SDK system messages that are NOT compact boundaries and have no displayable parts should still be dropped (return `null`). This preserves the existing behavior for `init`, `hook_response`, etc.

### U5: UI rendering

**Files:** `src/client/components/MessageList.tsx`, new `src/client/components/CompactBoundary.tsx`

**Changes:**

1. Create `CompactBoundary.tsx`:
   ```tsx
   import { Separator } from '../ui/separator' // or plain div
   export function CompactBoundary() {
     return (
       <div className="my-4 flex items-center gap-3">
         <div className="h-px flex-1 bg-border" />
         <span className="text-xs text-text-tertiary font-medium uppercase tracking-wide">
           Conversation compacted
         </span>
         <div className="h-px flex-1 bg-border" />
       </div>
     )
   }
   ```

2. In `MessageList.tsx`, modify the `system` role branch in `renderMessage`:
   ```tsx
   if (msg.role === 'system') {
     if (msg.isCompactBoundary) {
       return <CompactBoundary key={msg.id} />
     }
     // existing error banner
   }
   ```

3. Add a compacting indicator. In the main `MessageList` component, read `isCompacting` from the store:
   ```tsx
   const isCompacting = useChatStore((s) => s.isCompacting[sessionId])
   ```

   Render it as a transient note inside `ConversationContent`, after the mapped messages:
   ```tsx
   <ConversationContent ...>
     {viewItems.map((item) => renderViewItem(...))}
     {isCompacting && (
       <div className="my-2 flex items-center gap-2 text-xs text-text-tertiary">
         <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
         <span>Compacting conversation…</span>
       </div>
     )}
   </ConversationContent>
   ```

**Virtualized variant:** Also update `VirtualizedMessageList.tsx` with the same `isCompacting` indicator and `isCompactBoundary` rendering path.

## Test Scenarios

| Scenario | Steps | Expected |
|---|---|---|
| T1: Live compact boundary | Start a session, send enough messages to trigger auto-compact or run `/compact` | A horizontal separator with "Conversation compacted" appears in the message list at the compaction point |
| T2: Live compacting indicator | Trigger `/compact` in a session | A transient spinner with "Compacting conversation…" appears below the latest message |
| T3: Indicator clears on completion | Wait for compact to finish | The spinner disappears when the boundary marker arrives |
| T4: Indicator clears on new turn | If the boundary event is missed, send a new user message | The spinner disappears on the next `assistant_start` |
| T5: Historical boundaries | Reload a session that was previously compacted | Boundary markers are visible in the loaded history |
| T6: Error messages unaffected | Trigger an error (e.g., interrupt during streaming) | System error messages still render with red destructive styling |
| T7: Type parity | After all edits | `diff src/client/types/message.ts src/server/types/message.ts` exits 0 |

## Risks

| Risk | Mitigation |
|---|---|
| SDK `status: null` is unreliable | Clear `isCompacting` on `assistant_start` as a fallback (D4) |
| `compact_boundary` arrives before `status: 'compacting'` | The boundary handler always sets `isCompacting = false`, which is idempotent |
| Historical system messages other than boundaries start appearing | `normalizeSessionMessage` only preserves system messages with `subtype === 'compact_boundary'`; all others with empty parts are still dropped |
| Virtualized message list diverges from regular | Apply identical `isCompactBoundary` and `isCompacting` rendering changes to `VirtualizedMessageList.tsx` |

## Files Modified

- `src/server/services/sse-emitter.ts` — U1
- `src/client/types/message.ts` — U2
- `src/server/types/message.ts` — U2
- `src/client/stores/chat-store.ts` — U3
- `src/server/services/message-normalizer.ts` — U4
- `src/client/components/MessageList.tsx` — U5
- `src/client/components/VirtualizedMessageList.tsx` — U5
- `src/client/components/CompactBoundary.tsx` — U5 (new)

## Verification Checklist

- [ ] `npm run lint` passes
- [ ] `npm run build:server` passes
- [ ] `npm run build` passes
- [ ] `diff src/client/types/message.ts src/server/types/message.ts` exits 0
- [ ] Manual test: `/compact` shows spinner and boundary
- [ ] Manual test: reload session shows historical boundary
