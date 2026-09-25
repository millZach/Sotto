# The AGENT_STATE broadcast omits a model catalog a window already has

Accepted September 23, 2026. Issue #286: typing in the Threads composer lagged while a thread worked. The shell/detail split that keeps `sotto:agents:state` free of thread history is described in `docs/perf/state-pipeline.md`, but no ADR covers it; this one records the model-catalog change below and stands for that corner of the split until a broader one is written.

## Context

Main coalesces every host change into one shell and pushes it on `sotto:agents:state` to both windows about 1.4 times a second while a thread works (`coalesceAgentStatePublishes`, `docs/perf/state-pipeline.md`). On the owner's installed catalog — 608 models — that shell is 649 KB, almost all of it `host.models` and the per-host copies `DesktopHostRouter` keeps under `host.clientHosts` for a window that combines several hosts. An earlier change (`docs/verification/composer-typing-lag.md`) made the selected host's entry and `host.models` the same array, so structured clone writes it once instead of twice; reading one shell still cost the window about 4 ms afterwards, almost all of it this one catalog, and the composer's keystrokes queue behind that read.

The catalog itself rarely changes — a model list is edited by a subscription or a provider reconnect, not by a keystroke — so most of those 4 ms are spent unpacking and reconciling hundreds of models the window already has. `AGENT_GET` and a command's own answer are read once, on demand, and must stay whole: they are what a window recovers with when it is missing something, so nothing about them changes here.

## Decision

**A model catalog on the coalesced broadcast is sent once per revision per window, not once per publish.** `AgentStateBroadcaster` (`src/main/agents/agentStateBroadcast.ts`) gives each catalog — `host.models` and every `host.clientHosts[].models` — a revision number that only advances when its content actually changes, compared with `isDeepStrictEqual` rather than by reference, because the projection that keys entities to their host (`clientAgentState`) rebuilds the array on every shell even when nothing in it changed. Each catalog is keyed apart with a `host:`/`client:` prefix rather than by host ID alone, so the selected host's `clientHosts[]` entry — today always the same array as `host.models`, by construction — cannot share a cache slot with it: if the two ever held different content, sharing a slot would flip one's revision out from under the other's own comparison on every publish, and neither could ever settle on `omitted` again. Apart from a catalog's own revision, each destination window (`main`, `widget`) keeps its own record of which revision it was last sent, updated only once `deliver()` reports the send actually reached it. A catalog whose revision matches what a window already has crosses as `{ revision, omitted: true }`; everything else about the shell is unchanged.

**The page puts the catalog back, not the preload.** `wrapAgentBridge` (`src/renderer/src/agents/agentStateCatalogs.ts`) wraps `window.sotto.agents` and `window.sottoWidget.agents` where `AgentContext` and the widget obtain them, ahead of every reader: a catalog sent in full is cached under its revision, and one only named by revision is read back from that cache and spliced into the shell before the listener ever sees it. Nothing downstream of the wrapper knows the wire ever changed shape. Reassembly does not live in the preload that first receives the broadcast, where an earlier version of this change put it: `contextBridge` clones every argument a main-world listener is called with on the way back across the isolated-world boundary, so putting the catalog back on the preload side would have cloned it again crossing back — undoing most of what omitting it saved. Only the small `{ revision, omitted: true }` marker needs to make that crossing when nothing changed; the page turns it back into the array the rest of the app already expects, using a cache that lives exactly as long as the subscription does — a reload runs the page fresh, so the cache empties exactly when the window's own memory of what it was sent does.

**Missing the revision a broadcast names recovers with `bridge.get()`, never an empty list.** A window that cannot resolve every catalog a broadcast refers to — a fresh window, an in-place reload, a message it never received — has no way to tell an omission from an empty catalog on its own, so it asks for the whole state instead, and tags what comes back with the revision that sent it looking, so an immediate repeat of that same omission is read from cache rather than asked for again. A broadcast that arrives while a recovery is in flight is kept, the newest replacing any earlier one. Main answers the fetch in order with its broadcasts, so anything kept was sent before the answer and is older than it: after a successful recovery the kept broadcast is not delivered, and only lends the cache a catalog it carried in full. After a failed recovery it gets its own attempt, from the cache or a recovery of its own. Nothing but a fresh broadcast ever starts a recovery, so a persistently failing fetch is retried at most once per broadcast, never on a timer of its own.

## Consequences

- On the owner's 608-model catalog (measured with `node:v8`'s `serialize`, which approximates what Electron's structured clone puts on the wire): an unchanged repeat fell from 649 KB to 1.1 KB, a 99.8% reduction. The first send after a real change is unaffected (649 KB plus 37 bytes of revision bookkeeping). Detecting "unchanged" with `isDeepStrictEqual` across both destinations costs about 0.5 ms per publish on that catalog, paid in main, not on the window's own thread. This figure is unchanged by moving reassembly to the page — it measures main's own encoding, not where the window puts the catalog back — and the page-side saving from not cloning the reassembled array a second time across `contextBridge` has not been separately measured; see `docs/verification/catalog-broadcast-omission.md`.
- A window's own memory of what it holds lives only as long as its wrapped bridge's closure does, so a reload or a fresh window empties it at exactly the moment the window's actual knowledge also empties, without main needing to notice the window came back — correctness does not depend on `windowManager.ts`'s `loadedRendererUrls` catching every reload path, only on `deliver()`'s return value gating what main assumes was received.
- `AGENT_GET` and `AGENT_COMMAND` (`src/main/agents/ipc.ts`) are unchanged: both still answer with a whole `AgentState`, model arrays included, because they are the recovery path this design depends on.
- The remote host socket protocol (`src/host/socketServer.ts`, `socketHostService.ts`) is untouched. It still sends a whole `AgentState` on every event; a catalog omission is only a property of the desktop's own broadcast to its two windows; see `docs/agent-control.md` if that protocol's own cost is addressed later.

### September 25 amendment: routine replies do not copy histories

Draft saves and voice-status reports now return the coordinator's shell directly,
including the model catalogs and exact draft persistence evidence. The desktop
router and host protocol already return a shell for commands. Previously the
coordinator first copied all loaded histories into a full reply, which the router
then discarded. On the owner's 80-thread session with about 20,400 activity
records, that intermediate copy took 226 ms on Electron's main thread; the shell
took 10 ms. This blocked desktop input even after the renderer's work was reduced.

Persistence, revision checks, error replies and the separate thread-detail channel
are unchanged. An explicit `get()` still returns the full state. Other command
paths retain their existing replies. The desktop's catalog recovery remains a
whole-catalog read, not an omitted-catalog broadcast. This changes no wire schema.

Renderer work also stays near the edited field: the pane and controls subscribe
only to the draft facts they display, a closed model picker does not group its
catalog, and repeated immutable history arrays reuse their reconciled identity.
Theme inspection and working-copy presence use explicit attributes rather than
broad descendant `:has()` selectors that invalidated the window on textarea edits.
See [the follow-up verification](../verification/composer-typing-followup.md).
