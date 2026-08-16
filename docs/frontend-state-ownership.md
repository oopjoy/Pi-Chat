# Frontend State Ownership Plan

This document is the design gate for step 3 of the 0.4.x convergence work. It defines state ownership and migration boundaries before any `App.tsx` code is moved.

## Objective

Split the frontend into three UI domains with one explicit integration coordinator:

| Boundary | Responsibility |
|---|---|
| `AppShell` | Application lifecycle presentation, global overlays, layout, settings, dialogs, and diff sidebar composition. |
| `SessionInventory` | Session list presentation and, after a later reducer migration, the canonical session inventory projection. |
| `ConversationPane` | The complete selected-conversation projection, owned by one reducer and rendered by one stable component. |
| App coordinator | API, SSE, cache, async authority checks, navigation intent, Runtime generations, and cross-domain commands. It is an integration boundary, not a fourth UI domain. |

The goal is fewer state authorities, not merely fewer lines in `App.tsx`.

## Non-goals

Step 3 does not:

- change HTTP, SSE, Runtime, cache, or navigation protocols;
- unify timing revisions or generations; that is step 4;
- move API calls or raw SSE handling into React components;
- replace `SessionViewCache`;
- rewrite local optimistic-turn reconciliation;
- change selectors, DOM order, visible behavior, or copy;
- key or remount `ConversationPane` when the selected Session changes.

## 3B Convergence Checkpoint

Step 3 is paused at a convergence checkpoint. The pure reducer, one pane state
owner, and stable render boundaries remain; step 4 and any further component
extraction are frozen until this checkpoint is accepted.

The accepted checkpoint must reduce authorities rather than adding a third
coordination layer:

1. no product feature, API, Runtime behavior, copy, style, or interaction changes;
2. every async visible pane update must go through `commitPaneIfCurrent` or
   `commitDraftIfCurrent`; a Session-ID comparison is never sufficient;
3. cache, request tokens, event versions, and Runtime provenance remain
   coordinator/transport facts and never enter the reducer;
4. `COMMIT_VIEW` receives a coordinator-normalized complete projection. The
   reducer does not merge cache, staged preferences, or command inventories;
5. tuple-shaped reducer setter facades are removed in behavior groups, rather
   than mechanically preserving the old setter model;
6. `ConversationPane`, `SessionInventory`, and `AppShell` are frozen as
   render-only boundaries. No further state move, hook extraction, or component
   split is in scope;
7. each convergence group runs typecheck, a clean-dist full test run, complete
   Playwright, and `git diff HEAD --check` serially. Build and E2E never run in
   parallel because both consume generated `dist`.

**Completed 3B convergence.** Prompt acknowledgement/rejection, draft picker,
command projection, coalesced warm, and control takeover are covered by
explicit $A \to B \to A$ behavior tests. `COMMIT_VIEW` is coordinator-normalized;
partial commands use the committed/cached projection only for the same Session,
whereas an explicit empty inventory still clears them. All tuple-shaped pane
setter facades and generic `SET_*` pane actions are removed. Runtime/settings,
prompt, queue, extension/control, streaming/terminal/settlement, and
pagination/history now use domain transitions. Async pane writes use
`commitPaneIfCurrent`, `commitDraftIfCurrent`, or the authority-checked atomic
view commit; raw reducer dispatch is reserved for synchronous user intent and
admitted SSE frames. This checkpoint does **not** authorize step 4 or further
component extraction: the render boundaries remain frozen.

The production-code watch set is `App.tsx`, `state/conversation-pane.ts`,
`components/ConversationPane.tsx`, `components/SessionInventory.tsx`, and
`components/AppShell.tsx`. Its line count is only an alarm; the acceptance
measure is fewer writable pane authorities and fewer async pane-write paths.

## Invariants

1. Only the App coordinator decides whether an async result may affect the visible pane.
2. `ConversationPane` never consumes raw SSE events and never calls `api`.
3. `ConversationPane` stays mounted across Session switches. `ChatInput` currently owns unsent text, images, attachment state, and submission state locally; remounting it would lose user input.
4. A committed Session view replaces the full pane projection atomically.
5. Incremental pane actions carry a Session identity and are ignored when it does not match the reducer's current Session.
6. Off-screen Session events update `SessionViewCache` and inventory state, but do not update the visible pane reducer.
7. Session rename/delete reconciliation, deletion tombstones, and fallback selection remain outside `SessionInventory` presentation until their ownership is migrated as one unit.
8. Reducer tests assert state transitions and invariants. They must not read implementation source or lock JSX/CSS shape.
9. Background Subagent status is an independent TopBar catalog owned by `use-background-subagents.ts` and `SubagentStatusControl.tsx`. It is keyed by the committed parent Session ID, aborts on navigation/unmount, and may hand App one verified `{parentSessionId, childSessionId}` read address. App reuses the Conversation pane for that JSONL transcript but keeps it strictly read-only; the child never enters Session inventory, Runtime readiness, Queue, Steer, Gate, presence, or control-owner authorities.

## Target Domains

### AppShell

Target-owned state:

- sidebar visibility and width;
- management section;
- appearance preferences;
- shutdown completion screen;
- session dialog visibility;
- diff sidebar visibility and width;
- application lifecycle;
- build identity mismatch and server build identity;
- Primary Runtime readiness presentation;
- global maintenance busy state;
- global notice and error presentation.

The first extraction is render-only. State moves only after component boundaries are stable and tested.

### SessionInventory

Target-owned projection:

- canonical `sessions` list and total;
- directory summaries;
- all/directory loading state;
- active Session IDs;
- failed, unseen-reply, mutating, and busy Session ID sets;
- pin, directory pin, collapse, and expansion preferences;
- optimistic rename/delete projection after its reducer is designed as one unit.

Initial extraction remains presentational. The App coordinator continues to own fetching, cache invalidation, optimistic mutation tokens, deletion tombstones, and navigation fallback. Moving only the array while leaving those authorities behind would create two inventory owners.

### ConversationPane

The selected pane uses one reducer-owned state object:

```ts
interface ConversationPaneState {
  identity: { kind: "none" | "draft" | "session"; sessionId: string };
  piState: PiState;
  messages: PiMessage[];
  pendingUserMessage: PiMessage | null;
  messageTotal: number;
  turnTotal: number;
  visibleTurnCount: number;
  messagesTruncated: boolean;
  stats?: SessionStats;
  liveMessage: PiMessage | null;
  commands: SlashCommand[];
  queue: QueuedPrompt[];
  queuePaused: boolean;
  toolStatus: string;
  extensionRequest: ExtensionUiRequest | null;
  runtimeStatus: "active" | "restoring" | "view-only" | "draft";
  control: {
    controlOwner?: string;
    controlledByThisWindow?: boolean;
  };
  gateAvailableOverride: boolean | null;
  draftWorkspaceCwd: string;
  promptStarting: boolean;
}
```

`gateMode` remains derived from the coordinator-owned per-Session Gate map during this step. Model inventory also remains outside the pane reducer; only the selected `piState.model` belongs to the pane.

The following existing fields are replaced by this reducer rather than copied into another hook:

- `state`, `messages`, and `pendingUserMessage`;
- message totals, turn totals, visible turn count, and truncation;
- `stats`, `liveMessage`, `commands`;
- `queue` and `queuePaused`;
- `toolStatus`, `extensionRequest`, `runtimeStatus`;
- `viewControl`, `gateAvailableOverride`;
- `draftWorkspaceCwd`, `promptStarting`.

`loadingEarlier` is deliberately **not** reducer state. Its request authority is the coordinator's per-Session pagination map, keyed by request token and navigation epoch. The visible value remains derived from the current committed pane identity plus that map; a stale A request must not clear a newer A request after an $A \to B \to A$ navigation.

## Coordinator Ownership

The App coordinator retains state and refs that decide authority or coordinate domains:

- desired, active, and remembered Session IDs;
- committed pane identity ref, navigation epoch, abort controller, first-pane timing, and scroll memory;
- per-Session earlier-history requests, keyed by pagination token and navigation epoch, and the derived loading display value;
- `SessionViewCache` and its overlay revisions;
- SSE lifecycle and reconnect policy;
- run epoch, run generations, settled generations, and event versions;
- local user-turn reconciliation and source turn totals;
- prompt busy leases and per-Session mutation admission display;
- Runtime warm single-flight state;
- pending per-Session model/thinking preferences and Gate mode map;
- optimistic rename/delete tokens and confirmed deletion tombstones;
- application lifecycle commands and all API operations;
- model inventory, workspace default, Session inventory, and shell state during the initial migration.

These values are not reducer-owned because they determine whether a fact is allowed to reach the reducer in the first place.

## Reducer Contract

The reducer accepts normalized facts, never transport events.

Atomic replacement actions:

- `COMMIT_BOOTSTRAP`: replace the selected Primary pane after bootstrap metadata and local-turn reconciliation are complete.
- `COMMIT_VIEW`: replace the entire selected Session pane after cache merge, staged preference overlay, and local-turn reconciliation are complete.
- `RESET_DRAFT`: create the local New projection while preserving the selected model and thinking defaults.
- `CLEAR_PANE`: clear a terminally deleted or unavailable selected pane.

The reducer exposes only domain transitions, not generic field setters:

- streaming/compaction: `AGENT_STARTED`, `LIVE_MESSAGE_UPDATED`,
  `TERMINAL_MESSAGE_COMMITTED`, `TOOL_RESULT_COMMITTED`, `AGENT_SETTLED`,
  `COMPACTION_STARTED`, `COMPACTION_FINISHED`, `PROCESS_FAILED`, and
  `STOP_COMPLETED`;
- prompt: target-matched `PROMPT_STARTED` and `PROMPT_PREPARING`,
  `PROMPT_ACKNOWLEDGED`, `PROMPT_REJECTED`, and `DRAFT_PROMPT_REJECTED`;
- queue: `QUEUE_UPDATED`, `QUEUE_DISPATCHED`, and `QUEUE_FAILED`;
- Runtime/settings: `RUNTIME_READY`, `RUNTIME_FAILED`,
  `RUNTIME_STATUS_CHANGED`, `PREFERENCES_STAGED`, and `SETTINGS_CONFIRMED`;
- extension/control: `EXTENSION_REQUEST_CHANGED`,
  `EXTENSION_REQUEST_RESOLVED`, and `CONTROL_UPDATED`;
- draft selection: `DRAFT_WORKSPACE_SELECTED`.

`ConversationPaneTarget` is a small synchronous identity matcher:
`{ kind: "draft" }` or `{ kind: "session", sessionId }`. It never grants
async authority; the coordinator has already made that decision before any
incremental dispatch. Earlier-history loading remains coordinator-derived from
its request map and has no reducer action.

Every Session-scoped incremental action includes `sessionId` and applies only
when:

```ts
state.identity.kind === "session" &&
state.identity.sessionId === action.sessionId
```

The three synchronous cross-kind transitions use `ConversationPaneTarget` and
require the matching draft or Session identity. Global or untagged incremental
pane actions are not allowed.

### Identity and asynchronous authority

The coordinator distinguishes three facts:

- `desiredSessionId`: the user's current navigation intent; it changes when navigation starts.
- reducer `identity`: the Session or draft already atomically committed to the visible pane.
- `committedPaneIdentityRef`: the synchronous mirror of reducer `identity`, updated only by the same coordinator commit helper that dispatches `COMMIT_VIEW`, `COMMIT_BOOTSTRAP`, `RESET_DRAFT`, or `CLEAR_PANE`.

No navigation, SSE, warm, setting, pagination, or deletion path may change committed pane identity independently. After 3B, there is no independent `localDraft` React state: UI derives draft status exclusively from `identity.kind === "draft"`. A coordinator-only draft intent ref may remain for synchronous pre-dispatch guards, but it is not a display authority.

A synchronous user intent or already-admitted SSE frame may dispatch its tagged
domain transition directly. There are exactly two legal asynchronous pane
submission paths:

1. `applySessionView(view, authority)` validates authority and commits one
   complete normalized Session projection.
2. `commitPaneIfCurrent(authority, action)` (or the draft equivalent) validates
   authority and commits one incremental pane transition.

An asynchronous continuation may not combine a Session-ID comparison and a raw
dispatch. The captured authority includes the relevant Session ID, browser-side
service-replacement `runEpochGeneration`, navigation epoch, current desired and
committed identity, and operation-specific token (such as pagination request
token or draft generation). `runEpochGeneration` invalidates continuations
admitted under an older Pi Chat service process; it is distinct from server
`runEpoch`, per-Session run generations, and RPC child generations. `takeControl`
also captures the Session event version, so a newer same-Session control SSE wins
over an older HTTP response. This protects both $A \to B$ and $A \to B \to A$:
an old A result cannot overwrite a newer A commit merely because its Session ID
matches again.

## Existing Path Mapping

### Bootstrap

Current path: `applyBootstrapMetadata` followed by `applyBootstrap`.

- Metadata and inventory updates stay in the coordinator.
- Cache storage and local-turn protection stay in the coordinator.
- `setViewedId` stays in the coordinator.
- The current group of pane setters becomes one `COMMIT_BOOTSTRAP` action.

The action payload contains the final staged-preference-adjusted `PiState`, protected transcript, totals, stats, queue, commands, live message, tool status, pending extension request, control projection, and active Runtime status.

### Session view

Current path: `applySessionView`.

The coordinator must complete, in order:

1. confirmed-deletion rejection;
2. authoritative cache remember or navigation merge;
3. unseen-reply reconciliation;
4. source turn-total recording;
5. local user-turn protection;
6. staged model/thinking overlay;
7. pending Gate auto-allow decision;
8. Session inventory and active-ID updates.

Only then does it dispatch one `COMMIT_VIEW` through the coordinator's committed-pane helper. No individual message, queue, control, or Runtime setter may run before that commit.

### SSE

Current path: `handlePiEvent`.

The coordinator retains:

- run epoch and generation rejection;
- malformed Session-event rejection;
- `viewingEventSession` calculation;
- cache patches for every Session;
- inventory activity projection;
- background refresh scheduling.

Only the already-authorized visible event becomes a reducer action. Examples:

| Authorized event | Reducer action |
|---|---|
| `agent_start` | `AGENT_STARTED` updates streaming, Runtime status, tool status, and prompt-starting in one transition. |
| `message_start` / `message_update` | The authority-gated scheduler dispatches `LIVE_MESSAGE_UPDATED`. |
| assistant `message_end` | `TERMINAL_MESSAGE_COMMITTED` appends the terminal row and clears the live draft in one transition. |
| `agent_settled` | `AGENT_SETTLED` clears streaming, compacting, tool status, live message, and prompt-starting together. |
| queue update / dispatch / error | `QUEUE_UPDATED`, `QUEUE_DISPATCHED`, and `QUEUE_FAILED` update queue and transcript together when exclusivity requires it. |
| extension request / resolution | `EXTENSION_REQUEST_CHANGED` / `EXTENSION_REQUEST_RESOLVED`. |
| control change / confirmed takeover | `CONTROL_UPDATED`. |
| process error | `PROCESS_FAILED` clears streaming state and changes Runtime status without partially reviving the pane. |
| completed stop | `STOP_COMPLETED` clears the visible stop transition in one action. |

Compound actions above are mandatory for multi-field user-visible invariants.
The reducer exposes no generic field setters.

### Local New

Current path: `createSession`.

- navigation cancellation, scroll memory, clear-view request, pending preference storage, and `setViewedId("")` stay in the coordinator;
- the repeated pane clear/setter block becomes `RESET_DRAFT`;
- the action receives current model, thinking level, and application-default cwd.

### Terminal delete

Current path: `finalizeDeletedSession`.

- tombstone installation, cache eviction, optimistic mutation cleanup, Session inventory removal, preference cleanup, navigation fallback, and pin cleanup stay in the coordinator;
- if the deleted Session is still visible, the pane setter block becomes `CLEAR_PANE`;
- a late view cannot undo this because the coordinator rejects confirmed deleted IDs before dispatch.

### Runtime warm and settings

`warmSessionRuntime`, `changeModel`, and `changeThinking` retain API and
current-view guards in the coordinator. Their visible results use
`commitPaneIfCurrent` with `RUNTIME_READY`, `RUNTIME_FAILED`, and
`SETTINGS_CONFIRMED`; a response for Session A may update A's cache but cannot
paint Session B or a later revisit of A.

## Component Interfaces

### ConversationPane

`ConversationPane` receives:

- the reducer state and derived presentation values;
- stable callbacks for send, abort, queue cancel/resume, navigation, control takeover, model/thinking/Gate changes, draft workspace pick, settings, and diff sidebar toggle;
- shell/inventory-derived context such as selected Session name, workspace, model inventory, Gate mode, loading state, and global mutation blockers.

It owns no asynchronous work. It must preserve the existing `<main className="chat-shell">` subtree and keep one unkeyed `ChatInput` mounted.

### SessionInventory

`SessionInventory` initially receives the existing `SessionSidebar` props as grouped `model` and `commands` objects. It performs no fetch, preference write, rename/delete reconciliation, or navigation. Its first purpose is to make cross-domain inputs explicit without changing authority.

### AppShell

`AppShell` initially composes:

- `SessionInventory`;
- the stable `ConversationPane`;
- sidebar restore control;
- `ManagementPanel`;
- `SessionDialog`;
- `ExtensionDialog`;
- `EditDiffSidebar`.

The shutdown-complete screen may remain an early return in the coordinator during the first extraction to avoid changing lifecycle behavior.

## Migration Sequence

### Phase 3A: Pure reducer

1. Add `src/web/state/conversation-pane.ts` with state, actions, initial state, reducer, and normalized commit payload helpers.
2. Add transition tests for commit, stale Session action rejection, draft reset, terminal append, queue/transcript atomicity, settled state, process failure, and clear.
3. Do not change `App.tsx` yet.

Acceptance:

- reducer tests use values and actions, not source regex;
- no API, cache, EventSource, timer, or React import in the reducer module;
- current application tests remain unchanged and green.

### Phase 3B: Replace pane state in App

The initial ownership migration is complete. Before any later step, execute the
following **3B convergence** cuts independently:

1. close confirmed authority defects and add explicit $A \to B \to A$ behavior
   coverage for prompt acknowledgement/failure, draft picker, commands, warm,
   extension, and pagination;
2. route asynchronous visible pane writes through only
   `commitPaneIfCurrent` and `commitDraftIfCurrent`; background results may
   update their Session cache but may not paint the pane;
3. remove tuple-shaped pane setter facades by behavior group: Runtime/settings,
   prompt acknowledgement/rejection, queue, extension/control,
   streaming/terminal/settlement, then pagination/history;
4. remove unused field actions and replace remaining common multi-field writes
   with domain actions;
5. normalize every `COMMIT_VIEW` payload in the coordinator before dispatch.

Acceptance:

- one reducer owns every field listed under `ConversationPane`;
- `applySessionView` performs one pane commit after reconciliation;
- async pane writes use only the two authority gateways;
- no Session-ID-only async visible pane write remains;
- no tuple-shaped pane setter facade remains once its behavior group is done;
- reducer commit actions do not own cache/staged-preference/command merge policy;
- existing `app-lazy-new`, local-turn, cache, navigation, queue, extension, and process tests pass.

### Phase 3C: Extract stable ConversationPane

1. Move only render JSX and prop types.
2. Keep the component unkeyed across Session changes.
3. Preserve DOM hierarchy, selectors, ARIA labels, and `ChatInput` mount identity.
4. Keep all commands in the coordinator.

Acceptance:

- unsent text and attachments survive Session navigation exactly as before;
- desktop and mobile E2E remain green;
- no `api`, EventSource, SessionViewCache, navigation epoch, or Runtime generation import exists in `ConversationPane`.

### Phase 3D: Extract SessionInventory and AppShell

Step 3 migrates **only ConversationPane state ownership**. In 3D, `SessionInventory` and `AppShell` establish stable presentational boundaries; their state continues to be coordinator-owned. Their final state migrations are outside phases 3A–3D.

1. Extract the presentational SessionSidebar adapter.
2. Extract outer composition and overlays.
3. Remove dead props and dead state only after usage verification. Known candidates are `sessionActionBusy` and the rendered `warmingSessionIds` state; their refs/behavior must be reviewed separately before deletion.

Acceptance:

- Session inventory authority remains single-source;
- AppShell contains composition, not session or conversation business rules;
- component extraction does not add mirror state.

## Verification Matrix

Every phase runs:

- `npm run typecheck`;
- `npm test` from a clean generated `dist` baseline;
- complete Playwright desktop/mobile suite;
- `git diff HEAD --check`.

Focused behavioral coverage must include:

- late activation/model/thinking/stop results from A cannot repaint B or a later revisit to A;
- an old pagination A request cannot clear a later pagination A request after $A \to B \to A$;
- navigation cache hit and cold JSONL first paint;
- prompt acknowledgement loss and explicit rejection;
- queued turn moves exclusively between queue and transcript;
- extension request resolution cannot be reopened by an old view;
- deleted Session cannot return from activation or navigation;
- New remains immediate and keeps its independent cwd;
- streaming terminal and settlement clear one coherent pane;
- ChatInput draft text and image attachments survive a switch away and back to
  the same mounted input instance;

## Rollback Points

Each phase must leave the application green and independently reversible:

- 3A adds only a pure unused reducer and tests;
- 3B changes ownership but not component structure;
- 3C changes component structure but not state ownership;
- 3D changes shell/inventory composition only.

The existing 3C/3D render boundaries remain in place rather than being rolled
back for churn. During convergence they are frozen: each review cut is labeled
as state semantics, render boundary, or test-only work so regressions remain
attributable.

## Step 4 Boundary

This design intentionally preserves the existing navigation epoch, Session event version, run epoch/generation, cache overlay revision, and optimistic mutation tokens. Step 4 may unify those contracts only after step 3 establishes one pane owner and explicit coordinator-to-reducer commands.
