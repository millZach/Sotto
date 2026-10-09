# The AGENT_STATE broadcast omits a model catalog a window already has

October 9, 2026 amendment: [ADR-0065](0065-remove-voice-control-and-thread-management.md) records the removal. The two-window agent-state broadcast below is historical: the widget no longer receives thread state, model catalogs or command receipts. Catalog revision handling remains for the main window and paired clients; the widget receives dictation state only.

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
- `AGENT_GET` and `AGENT_COMMAND` (`src/main/agents/ipc.ts`) are unchanged: both still answer with a whole `AgentState`, model arrays included, because they are the recovery path this design depends on. The September 26 amendment below changes this for `AGENT_COMMAND`; `AGENT_GET` still answers whole.
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

### September 26 amendment: a command's answer is a receipt

Issue #323. This changes the Decision above, which kept a command's answer whole as a recovery path. After the
September 25 amendment a reply no longer copied histories, but every draft save and every chip press still
carried the whole model catalog to the window. On a synthetic 608-model catalog that is 542 KB for one draft
save, cloned into the window and parsed there by the preload's schema on every save.

**`AGENT_COMMAND` now answers with a command receipt.** It is the shell after the command, with its outcome
(`error`, `notice`), the evidence its caller acts on (`threadDraftPersistence` for the exact draft revision
saved, `configuration` for the effective settings) and every other field of the shell, whole, whether or not
the command changed it. It is not a diff: without the catalogs the shell is about 2.3 KB, and a diff would need
an ordering of its own against the broadcast. The model catalogs are the exception: `host.models` and each `host.clientHosts[].models` cross as `{ revision, omitted: true }`, naming
their catalog revision. `AgentStateBroadcaster.encodeReceipt` encodes it with the same revision counter the broadcast
uses, so there is one ordering for a catalog, not a second one for replies. A receipt records nothing as sent,
so the next broadcast to that window is what it would have been without the receipt. The preload parses it
with `agentCommandReceiptSchema`, which accepts a catalog only as a revision. The preload's own bridge is typed
as what crosses (`AgentWireBridge`: a receipt from `command`, an `AgentStateBroadcast` from `onState`), so code
that reads it without the page's wrapper cannot read a catalog from it by mistake.

**The page puts the catalog back from the cache the broadcast fills.** `wrapAgentBridge` now wraps `command` as
well as `onState`, and the two share one cache per page. A receipt whose revisions the window holds resolves
at once. So does one naming an older revision than the window holds: revisions only advance, so that receipt
was built before a broadcast the window already has, and the newer catalog is the one to show. One whose
revisions the window does not hold at all (nothing broadcast yet, or a catalog this command changed whose
broadcast has not landed) recovers through `bridge.get()`. Receipts naming the same hosts at the same revisions
while that is in flight wait for the same answer; the match names each catalog by the key main counts its
revisions under (`hostCatalogKey`, `clientCatalogKey`). The recovered catalog is filed under the receipt's revisions, where the next receipt or broadcast
naming them finds it, and a catalog the cache still cannot name is taken from the recovery's own answer. The
caller always gets the receipt's own fields, never the recovery's. A recovery that fails is asked once more
before anything else, because main has already run the command and a failed reply tells the user it may not
have. If that fails too, the reply still resolves with the receipt's own fields: the catalog the window last
held stands in, or the one the last `get()` listed, until the next broadcast. A window that holds neither was
never sent that catalog, so main recorded none as sent to it and the next broadcast carries it in full; until
then that host has no models, which is what the window already showed. Where the reply is committed against broadcasts is
unchanged: `AgentContext` still drops a reply that a broadcast overtook. The catalog revision orders only
catalogs. Issue #306 is open; if it gives the state its own revision, the receipt carries that revision too.

Two sentences of the Decision above no longer hold. The page's cache no longer "lives exactly as long as the
subscription does": it lives as long as the page, and every `onState` listener and every command share it, so
a listener that subscribes again finds what an earlier one was sent rather than recovering. And it is no longer
true that "nothing downstream of the wrapper knows the wire ever changed shape" for code that calls the
preload's bridge directly: its `command` answers with a receipt. Everything the app reads goes through the
wrapper, which still hands back a whole `AgentState`.

The broadcast and the receipts advance one counter from two places with no order between them. A reply shell
built before a catalog changed can be encoded after the broadcast of that change: it takes a new revision for
the old content, and the next broadcast takes another for the new content. The window that sent the command
reads `AGENT_GET` once for that reply. The next broadcast then sends the catalog in full to both windows, the
widget included, although the widget never saw the receipt: to main the catalog changed twice. Nothing wrong
reaches the screen, because the
recovery answers with main's current catalog. Naming the old content by its old revision instead was
considered and not done: main cannot tell that reply from a catalog that really went back to what it was,
such as a provider that reconnects, and a window holding the newer revision would then keep showing it.

`AGENT_GET` is unchanged and still answers whole: it is the one recovery path for both. The remote host socket
protocol is untouched. A content comparison now serves every key that holds the same array: `host.models` and
the selected host's `clientHosts[]` entry are one array in a shell, and one shell is encoded for both windows.
A receipt costs main one comparison of the catalog (about 0.8 ms on the synthetic 608 models), and a publish
of one host's shell to both windows costs one where it used to cost four.

The draft save's reply fell from 542 KB to 2.3 KB. The preload's parse of it fell from about 2.5 ms to 0.04 ms
and its copy from about 2.2 ms to 0.015 ms. See [the measurement](../perf/2026-09-26-command-receipt.md).

### October 3 amendment: a paired phone gets the catalog once per revision

Issue #699. This changes the Consequences above, which left the remote host socket protocol untouched. Every
shell the socket listener sends a client carried the whole model catalog: on the owner's 753-model install,
765 KB of a 1.1 MB shell, written again on every 50 ms publish while any thread worked, over Tailscale to the
iPhone, which decoded all of it each time.

**A client that accepts the `model-catalog-revision` host feature is sent the catalog once per revision per
connection.** Protocol version 1 is frozen (ADR-0025), so this is a host feature the client asks for in hello's
`accepts`, offered by both the headless host and the desktop's phone listener. To such a client every shell
names the catalog's revision in a new optional field, `host.modelsRevision`, and carries `host.models` only when
no frame on this connection has carried that revision whole yet. The rule is the same for hello, a `shell` read,
a command's answer and every shell push. The shape differs from the window broadcast's on purpose: there
`models` becomes `{ revision, omitted: true }`, but on the socket `models` keeps the one meaning v1 gives it, a
list, and is left out beside the revision. `docs/host-protocol.md` has the rule as a client reads it.

The revisions come from the same machinery as the broadcast's. `ModelCatalogRevisions` is the counter and
content comparison `AgentStateBroadcaster` already used, now its own class in `agentStateBroadcast.ts`, which
the broadcaster keeps using. Each socket listener has one, so a revision names one catalog for as long as the
listener runs. What each connection was sent is its own: the revision a written frame last carried whole,
recorded only once `deliver()` reports the frame itself went, not a `too_large` error in its place. The listener
encodes a shell for its connection only as it writes it, so that record follows the order the frames go out
in. Hello starts the record afresh, and a new connection starts with nothing recorded.

A command's answer follows the same rule rather than always naming the catalog, as a window's receipt does.
A window recovers through `AGENT_GET`; a socket client has no read that ignores what it was sent, because a
`shell` read follows this rule too. Its recovery is a new connection. The iPhone keeps the last catalog its
connection carried whole and puts it back into every shell that names that revision, in `HostConnection`, the
one place frames enter the app, so every reader still sees a whole catalog. It keeps it in the order frames
arrive: a reply's catalog is read with its envelope as it arrives, and each reply is matched with the catalog
that was current then, however much later its caller decodes it. A shell naming a revision the phone does not
hold should not happen; the phone then drops the connection and connects again, and the new hello carries the
catalog whole, rather than showing the computer with no models.

A client that does not accept the feature is sent exactly what it was sent before. That includes every iPhone
build from before this change and the desktop's own host client (`SocketHostService`), which does not ask for
it: a remote host's catalog still reaches the desktop whole, and the broadcast then spares the windows the
repeat as it always has. Asking for it there is left for later.

A repeat shell to the phone fell from 692,553 bytes to 7,173 bytes on a synthetic 753-model catalog. Comparing
the catalog costs the listener about as much per publish as writing it out used to, about 1.5 to 2 ms for each
client that accepts the feature, so the saving is on the wire and on the phone, not in the listener. See
[the measurement](../perf/2026-10-03-phone-model-catalog.md). It takes effect with an iPhone build that asks
for the feature.
