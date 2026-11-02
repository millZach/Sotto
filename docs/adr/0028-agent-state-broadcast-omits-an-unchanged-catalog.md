# The AGENT_STATE broadcast omits a model catalog a window already has

October 9, 2026 amendment: [ADR-0068](0068-remove-voice-control-and-thread-management.md) records the removal. The two-window agent-state broadcast below is historical: the widget no longer receives thread state, model catalogs or command receipts. Catalog revision handling remains for the main window and paired clients; the widget receives dictation state only.

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

## Amendment: the catalog keeps its identity (October 10, 2026, #917)

`clientAgentState` no longer walks the catalog, which names no Sotto entity, and adapters now certify their catalogs (ADR-0016, October 10 amendment), so a shell carries the same frozen array from one publish to the next until a catalog actually changes. The identity check in `sameContent` then answers, and the content comparison with `isDeepStrictEqual` remains for a catalog that is not certified or whose identity changed.

## October 13, 2026: the desktop omits unchanged thread bodies (#991)

Withdrawn October 15, 2026; see below.

The existing `streaming-publish-cost` Owl answer, read once at startup, also governs the desktop's thread encoding. With that answer false, the broadcaster executes its prior path and sends the whole ordered thread array. No second switch, setting or host feature is introduced. Command receipts still carry their own whole thread array and outcome, configuration and draft-persistence evidence. Encoding a receipt neither names nor confirms delivery of thread bodies.

With the answer true, only `host.threads` on the desktop state broadcast changes shape. It becomes an envelope with `revision`, `baseRevision`, `roster` and `changed`. The roster names every current Sotto thread ID and its content revision, in current order. Changed entries carry a content revision and the whole thread body. The roster governs additions, deletions and reordering; host-qualified Sotto IDs keep different computers' threads distinct. All other shell fields stay whole, including selection, drafts, pending work, attention and busy state.

A content revision names one whole shell-thread value. It is distinct from a detail revision, history epoch, catalog revision and event sequence. One broadcaster-wide counter allocates each new content revision, including an ID deleted and later readded. Main compares every incoming thread's complete content with its owned previous snapshot. The private comparison seam accepts inert producer snapshots: local and remote shell reads materialize plain data with `structuredClone` before the router projects it. It compares every enumerable own string key and value, scalar distinctions, prototypes and array length. Differing key order, symbol keys, unexpected nonplain values and depth beyond 64 restart native `isDeepStrictEqual` on the original roots. It does not compare arbitrary accessor-bearing JavaScript objects. Weak metadata remembers only private owned container shapes, using keys already enumerated while copying; incoming fields are read fresh. Activity certification or a repeated incoming reference does not certify mutable summary, worktree, usage or request fields. Only current live bodies are retained. Comparison snapshots and outgoing bodies own separate mutable containers.

An envelope revision names an attempted broadcast. Its base names the most recent successfully delivered thread envelope, or is null for a complete envelope containing every roster body. A failed or thrown send cannot advance the successful base or its sent content revisions. Delivery commits the captured revisions, never a later read of mutable input or payload. A complete read during delivery invalidates that commitment and forces another complete envelope.

The page reconstructs the ordered whole array after contextBridge, never in preload. It validates the base, roster identities, body identities and matching content revisions before committing a new roster or delivering a state. Missing bodies or revisions and duplicate or extraneous identities cause a complete read, never an empty list. Every emitted shell has writable thread objects separate from the page's private revision cache and earlier emitted shells. The narrow copier operates on the thread schema's plain data; unexpected nonplain values use native whole-graph cloning. This is a transport ownership rule, not immutable certification or unchanged-thread sharing in the ingestion layers (#925).

`AGENT_GET` remains a complete, unversioned state. An authorized main-window read resets the broadcaster's successful thread-delivery base; the next push carries every thread body. The page never files recovered thread content under the older revisions that caused the miss. Thread misses and catalog misses remain independent. Raw broadcasts and command lifecycle changes advance a page observation counter: an outstanding read cannot overwrite facts observed after that read began. A newer complete or assemblable broadcast may land immediately; a newer unresolved broadcast gets its own bounded recovery after the old read settles. Each incoming broadcast can start at most one recovery, with no timer retries; unsubscribe prevents late delivery. Receipts retain their own command facts even when a broadcast overtakes their display.

This amendment changes only the desktop window transport. The socket protocol and its catalog negotiation are unchanged: a paired phone follows its connection's negotiated host features, and the desktop's remote-host reader still obtains whole remote shells. The dictation widget continues to receive no thread state. Measurements distinguish the pre-edit wire baseline, paired legacy/optimized coordinator runs with earlier optimizations held constant, and the actual Electron IPC/contextBridge plus page reconstruction and reconciliation costs.

A command can settle without replacing the subscription's state: rejection supplies no receipt, and a successful worktree preview supplies facts its caller deliberately does not apply as a shell. Every command settlement notifies only unresolved optimized subscriptions to request one fresh complete read, after an already held read finishes if necessary. The caller receives its own outcome before a fresh recovery shell is delivered. Recovery never reassembles the old envelope, even if a receipt has since filled its catalog, and never assigns that envelope's catalog revision to the fresh read. A queued broadcast is replayed only while no later command or broadcast has overtaken its observation. A newer assembled state clears unresolved work; unsubscribe disposes it. A read begun after a command started can deliver current facts while that command remains pending, and valid broadcasts never wait for commands. Read failure alone never starts an automatic retry loop.

## October 15, 2026: the thread envelope is withdrawn

The desktop now sends the whole ordered thread array on every broadcast again, whatever the `streaming-publish-cost` answer says. The October 13 envelope above is history, not current behaviour.

Measured with the switch on and with it off, the envelope cost main more than the smaller payload saved. The broadcaster's send step rose from about 4–5 ms to 6.5–7 ms per send, and main's total busy time while threads streamed was 5–8% higher with the envelope on (30–45 ms more per second), within noise otherwise. `docs/perf/2026-10-13-window-thread-shell.md` already said its full-pipeline runs did not establish a consistent win, and the deeper comparison and the extra copies the envelope needed were the reason: main paid for a comparison on every thread on every publish to save a payload that was not the bottleneck.

Unchanged-thread sharing in the snapshot and ingestion layers remains #925's; this amendment only withdraws the broadcast transport layered on top of it.

## October 16, 2026: the desktop's host client takes the catalog once per revision too

The October 3 amendment left the desktop's own host client taking the whole catalog in every shell. On the owner's forge host that client fell more than an hour behind a busy Claude Code thread: in 1 hour 46 minutes the host wrote 938 MB to it over Tailscale Serve while it received 186 KB, and the desktop's main process spent a whole core reading. The catalog went whole in every shell push, every command's answer and every `shell` read.

The desktop's client now accepts `model-catalog-revision` like the iPhone. It keeps the catalog its connection last carried whole, puts it back into every shell naming that revision before it reads the shell, and drops `modelsRevision`, so nothing past the client sees the wire's form. It does this before matching an answer to its request, so a catalog carried by an answer that arrived after its request timed out is still kept. A shell naming a revision it does not hold closes the connection, and the desktop connects again as it does after any drop, with a hello that carries the catalog.

## October 22, 2026: the window is sent only the thread records that changed (#1330)

This changes the October 15 section, which went back to the whole ordered thread array on every broadcast. A one-minute activity recording of main on 0.1.38-owl.20261021.2 (Windows, about 290 threads) put 2.9 s of main's 30 busy seconds in serializing `AGENT_STATE` for the window, every broadcast, up to one each 16 ms while a thread streams, carrying every thread's shell record. The window spent about 5 s of the same minute in its state sharing working out which records had not changed.

**A broadcast's `host.threads` is the records that changed since the window's last broadcast** (`AgentThreadsBroadcast`). It names its own `revision` and the `base` it is measured from, and carries `changed` (each record new or changed since the base, whole), `removed` (the Sotto thread IDs of threads that went, when any did) and `order` (every thread's ID, only when the order or the threads differ from the base's). A complete broadcast has a null base and every record in `changed`, in order. Main (`ThreadRecordsBroadcast` in `agentStateBroadcast.ts`) keeps the records it last sent and compares each incoming one with the record of the same ID: identity first at every level, then a walk of plain data (`samePlainData`). Since #925 step 6 (October 26, 2026), when the router notes the list as made from the base's in place, it compares only the records at the positions the notes name, and every other record is the base's own; a list noted nowhere is compared record by record as before (ADR-0016's #925 amendment). Only a send `deliver()` reports as delivered becomes the base. Every field of the shell other than `host.threads` is whole, as before, and the catalogs follow their own revisions.

**A window that loads, reloads or cannot apply a broadcast reads the whole state, and the next broadcast lists every record.** `AGENT_GET` tells the broadcaster (`windowRead`) before it reads, and the broadcaster drops its base; a read while a send is being delivered voids that send as a base too. The page (`createThreadReassembly`, wrapped into `wrapAgentBridge`'s reassembly) keeps the records it was last broadcast and rebuilds the whole ordered array before any reader sees the state. It applies a broadcast only when it holds exactly that base and every ID resolves: a changed record has its place, every held thread is still listed or said to have gone, and no ID repeats. Anything else changes nothing it holds and goes the catalog's way: one `AGENT_GET`, with a broadcast that arrives meanwhile kept as the catalog rules above keep it. A list in which two records share an ID goes complete and leaves no base, as the whole array did. Two records with one ID cannot be told apart by ID.

**The page hands back the record it holds for a thread that did not change, and state sharing remembers a reconciled record** (`createStateSharing`), so an unchanged thread meets the state's own record by identity instead of being walked on every broadcast. The rebuilt state is equal to what main broadcast, field for field: `tests/unit/renderer/agentStateThreads.test.ts` runs main's broadcaster and the page's wrapper over structured-cloned payloads through changes, additions, removals, moves, lost messages, failed sends and reads, including broadcasts that reach the page while its read is still in flight, and `tests/perf/windowChangedThreads.perf.test.ts` checks every state the page rebuilds against the state the router published while three threads stream at the owner's scale, on Owl and on stable.

This is not the October 13 envelope again. That one sat behind the `streaming-publish-cost` answer, kept an owned snapshot of every thread and gave every emitted shell writable copies, so main paid a deep comparison and copies on every publish. This one is on every track, keeps references to what it sent rather than copies (a publish is read, never written into), and compares mostly identities: the router builds a new record per thread per publish, but what each holds is the coordinator's or a remote host's. The `streaming-publish-cost` answer is unchanged and still governs what it governed before. Command receipts still carry every thread whole and move no base. `AGENT_GET` is unchanged. The socket protocol is untouched, and the dictation widget still receives no thread state.

Measured on the owner-scale pipeline (291 threads, three streaming, `node:v8` serialization standing in for Electron's, medians of 51 streaming broadcasts): a broadcast fell from 260,910 bytes to 12,525. Main's encode and serialize fell from 1.31 ms to 1.02 ms per broadcast: the comparison costs about 0.3 ms, because the snapshot layers still rebuild each thread's summary, requests and usage on every publish (#925, #1326); with those shared, it is identities only. The page's read, reassembly and state sharing fell from 5.7 ms to 0.47 ms. On stable (290 threads) the same run measured 258,845 bytes to 11,496, main 1.22 ms to 0.90 ms and the page 3.8 ms to 0.24 ms.

The catalog comparison hits its identity shortcut on a broadcast where the catalog did not change. `ModelCatalogRevisions` now keeps the array it last found equal as the one its revision stands for, with its length, so a shell that hands over one array from publish to publish meets it by identity. Before, the stored array stayed the first one seen, and with more than one host the single remembered comparison was the other host's, so the 608-model catalog went through `isDeepStrictEqual` on every publish.

## October 29, 2026: the desktop's host client reads a held catalog once (#996)

The October 16 amendment had the desktop's client put the catalog it holds back into every shell naming its revision and
then read the shell, catalog and all. So every push read the catalog into a new array, and every comparison downstream,
the window's broadcast among them, compared it by content again.

A shell naming a revision the connection holds is now read without its catalog. The first shell that carries or names a
revision is read whole, and that reading is frozen and kept with the revision; every later shell naming it, a push, a
command's answer or a `shell` read, is read with an empty catalog and handed that same array. A revision names one
content, so a catalog carried whole again under the same revision keeps the reading. The client also hands the listeners
of its pushes its state as read, without a copy, as a local host's broadcast is handed: the router, the only listener,
reads a few fields of it and builds what it publishes from its own read.

On the owner-scale benchmark (`tests/perf/dataTransfer.perf.test.ts`, a host thread streaming), the client's time per
push fell from 10.2 ms to 5.2 ms and the window broadcast's catalog comparison from 29.2 ms to 0.9 ms over 60 pushes
(`docs/perf/2026-10-29-data-transfer.md`).

## October 30, 2026: a command's reply carries only the thread records that changed

The October 22 section left command receipts carrying every thread whole. Every command the window sends answers with
one: a draft save at each pause in typing, Refresh on every pane at every window focus, selecting a pane, telling main
which panes are open. At the owner's scale (293 threads) a draft save's reply was 272,706 bytes. The window spent about
6.5 ms on each: 1.4 ms receiving it, 3.1 to 3.3 ms in the preload checking every record against the thread schema, and
1.9 to 2.1 ms in state sharing walking every record, all fresh objects, before contextBridge copied them once more.

**The main window's page asks for a reply's threads as the changed thread records since its last broadcast.** The preload gives the
page a second command method, `commandWithChangedThreadRecords`, which sends `{ changedThreadRecords: true }` beside the command.
Main answers it with `encodeChangedThreadRecordsReceipt`. That is `encodeReceipt`'s receipt with `host.threads` in a
broadcast's shape (`AgentThreadsBroadcast`), measured by the same `ThreadRecordsBroadcast` from the last broadcast the
window was delivered, and recording nothing as sent. The next broadcast is measured from the same base and carries the
same changes. A reply before any broadcast, or after the window read the whole state, lists every record with a null
base. Only the main window may send a command, and only it is broadcast to, so the base is always its own.

**The preload still checks what crosses.** The changed records are parsed against the thread schema, as every record of
a whole reply was, and the base, revision, removals and order structurally (`agentCommandChangedThreadRecordsReceiptSchema`).

**The page puts the threads back from the broadcast it holds, and moves nothing it holds.** The subscription's
reassembly (`createThreadReassembly`) reads the reply's changed records against its held records with `peek` and keeps them
held, so a reply never changes what the next broadcast is applied to. A thread the reply did not change is the record the
broadcast gave, so state sharing meets it by identity. A reply that overtook the broadcast it was measured from waits for
it (October 31, #1939): main sent that broadcast first, but the two cross separately and a busy computer can deliver the
reply first. When the reply names a newer base than the one held, `peekOnArrival` puts it back from that broadcast the
moment it is held, before a later one replaces it, for up to a second. A reply measured from a broadcast the window does
not hold, an older one or one that did not come in time, reads the whole state through `AGENT_GET`. That read is begun
for the reply alone, after it arrived, so
it holds the reply's own command; a catalog's recovery may be shared, since its revision only advances. The next
broadcast then lists every record. When that read fails twice, the reply carries the whole list the window was last
broadcast, never its changed records alone, and the next broadcast carries the change. In a real window the command
receipt journey (`tests/e2e/command-receipt.spec.ts`) types into a composer and counts no whole-state read while the
draft saves. A page with no subscription yet asks for the whole reply. Every other caller of the preload's `command`,
the e2e specs included, still gets every thread whole.

Measured with the data-transfer benchmark at the owner's scale, a draft save's reply, three runs each: 272,706 bytes to
11,462. The window's work fell from 1.38-1.39 ms receiving it, 3.12-3.25 ms checking it and 1.86-2.11 ms sharing it to
0.10-0.11 ms, 0.31-0.33 ms and 0.19-0.20 ms, with 0.08-0.10 ms more to put the threads back: about 6.5 ms to 0.7 ms per
reply (`docs/perf/2026-10-30-command-reply-threads.md`).

## October 30, 2026: a paired host's shell pushes carry only the thread records that changed (#996)

The October 22 section left the socket protocol untouched, so a paired host still pushed every thread record whole in
every shell push. While a thread on the host streams, it pushes the shell up to twenty times a second to each connected
client. On the owner-scale benchmark (`tests/perf/dataTransfer.perf.test.ts`, about 290 threads on the host) each push to
a desktop was 232,942 bytes, about 11 KB deflated, for a change to one thread's record. The desktop's host client then
parsed every record against the thread schema, and the router compared every one, all fresh objects, before the window's
broadcast found the one that changed.

**A host lists a new feature, `changed-thread-records`, and the protocol stays v1** (ADR-0025). Every listener lists it,
to desktops and phones alike. A client that accepts it in hello is sent each shell push with `threads`, the changed
thread records since the last shell push written to that connection, in the window's broadcast shape
(`AgentChangedThreadRecords`), and with `state.host.threads` empty. The host keeps one `ThreadRecordsBroadcast` per such
connection and encodes each push's thread list with it. A push becomes the base only once it is written. A push that
repeats the last one, is held for Watcher's writing window or goes as a `too_large` error moves nothing. A push whose only
news is a thread record is written, though the rest of its state repeats the last. Hello, a `shell` read and a command's
answer still carry every record and move nothing. A `shell` read drops the base, so the push after it lists every
record.

**The desktop's host client accepts the feature wherever the host lists it, and puts each push's list back before
anything reads it.** It keeps the records the last push carried with the page's reassembly, moved from the renderer to
`src/shared/threadReassembly.ts` so main and the page share one. A thread that did not change is the record the client
already holds, so the router and the window's broadcast meet it by identity. A push measured from records it does not
hold, which should not happen on one ordered connection, is not shown. The client reads the shell whole instead, and
the host's next push lists every record. A new connection starts with nothing held on either side.

**The iPhone accepts it too, and puts each push's list back the same way** (`ThreadRecordsCache` in SottoCore, ported
from `threadReassembly.ts`). The connection holds the records beside the catalog it holds, in socket order, and a push
it cannot put back starts the connection again, as a catalog revision it does not hold does. The new connection's hello
lists every record. An earlier iPhone build, the Android client and any other client that does not accept the feature
are sent every record in every push.

On the benchmark, three runs before and after on forge, with one host thread streaming for 60 pushes: a desktop push
fell from 232,942 bytes to 11,929-11,950 (about 11,100 to about 1,970 deflated). The first push of a connection, and
the first after a `shell` read, lists every record (205 KB). The desktop client's work on its pushes fell from
295-303 ms to 67-73 ms, about 5 ms to 1.2 ms a push. The host's shell sends to its three clients fell from 287-293 ms to
236-248 ms. The whole process, host, clients, router and window together, used 889-945 ms of CPU against 1,490-1,532 ms.
The window was broadcast the same thread records as before. For a phone, a shell push after a send on the open thread
fell from 220,462 bytes to 6,946, and reading one push on a Mac test runner from 3.88-4.44 ms for every record to 0.68 ms for
one changed record put back (`docs/perf/2026-10-30-host-shell-thread-records.md`).

## October 30, 2026: a broadcast keeps the parts that did not change

The October 22 section left every field of the shell but the threads whole on every broadcast. That is the drafts, the
receipt lists, the deliveries, the projects, the providers, the paired hosts and the settings, and nearly none of it
changes while a reply streams. On the owner-scale benchmark a broadcast with one thread streaming was 14,580 bytes, about
2.7 KB of it the record that changed, up to seventeen times a second. With full receipt lists the audit estimated about
80 KB a broadcast. The page then walked every one of those parts again in state sharing, all fresh objects.

**A broadcast leaves out each part that holds what the broadcast its threads are measured from held, and names it in
`kept`** (`withKeptParts` in `agentStateBroadcast.ts`). The parts are the shell's top-level fields and its `host` fields,
but the threads; a catalog's encoding (a revision, or the catalog whole) is a part like any other. Main keeps the parts of
the last broadcast the window was delivered, under its thread revision, and compares each with `samePlainData`, identity
first. It keeps nothing when the threads list every record, as after the window read the whole state: `windowRead`
drops the parts with the threads' base, and a delivery a read voided leaves neither.

**The page puts each kept part back from the broadcast it applied, before anything reads the state.** It holds the last
broadcast whose threads it applied, as it crossed with its kept parts put back. A broadcast measured from it gets each
kept part back as that very object, so state sharing meets it by identity. One measured from a broadcast the page does not
hold, or naming a part it does not hold, is read whole through `AGENT_GET`, as a broadcast whose threads cannot be
applied is. Command receipts keep carrying every part.

On the owner-scale benchmark, three runs each on Owl, a broadcast with one thread streaming fell from 14,580 bytes to
2,680, with three from 18,818 to 6,918, and a draft save's from 12,600 to 1,452. In `windowChangedThreads.perf.test.ts`
(291 threads, three streaming) a streaming broadcast fell from 13,624-13,635 bytes to 4,358-4,410 on Owl and from 12,574
to 4,466 on stable. The page's work per broadcast fell from 0.212-0.216 ms to 0.126-0.127 on Owl and from 0.189-0.194 to
0.128-0.136 on stable, and main's from 0.076-0.079 to 0.062-0.065 and 0.120-0.129 to 0.113-0.118
(`docs/perf/2026-10-30-window-kept-parts.md`).

## November 1, 2026: a phone's connect lists the threads once and each provider's modes once

The owner's iPhone took 10 to 30 seconds to connect to the laptop on a slow network, and under a second to forge. The
network, the TLS and the host were not the difference: the laptop answered hello in 79 ms. The bytes were. On the
laptop, with 632 threads and a catalog of 942 models, a connect sent the phone 4.5 to 5.7 MB, and 8.3 to 9.2 MB when the
phone checked its deliveries with a `shell` read; forge, with 67 threads and 48 models, sent 0.23 to 0.78 MB. Phones are
not sent compressed messages (ADR-0025, October 18 amendment).

Two parts of that were sent twice. The first shell push after hello listed every thread record again (1.7 MB), because
the October 30 amendment measured a connection's first push from nothing, and so did the push after a `shell` read. And
every model carried its provider's modes: Devin's 846 models each carried the same 962-byte list, 814 KB of a 1 MB
catalog.

**A hello and a `shell` read name the revision of the records they list, and the next push is measured from them**, to a
client that accepts `reply-thread-records` beside `changed-thread-records`. The listener seeds the connection's
`ThreadRecordsBroadcast` with the records the answer lists and makes them its base once the answer is written; a send
that had not become the base by then is voided, as a reset voids it. The answer carries `threadRecordsRevision` on its
shell. The iPhone holds those records with the answer's envelope, in socket order, as it holds a catalog an answer
carries: an answer's caller reads it after later pushes have been handled, so holding them there would be too late for
the push that follows. A command's answer names nothing and moves nothing.

**A catalog lists each distinct list of provider modes once, and each model names its list by its place**, to a client
that accepts `provider-mode-lists`. Places rather than a list per provider, so a provider that ever gives two of its models
different modes still reads exactly, and a model without modes is sent as it is, so it is never mistaken for one that
names a list. The iPhone puts each list back before anything reads the catalog.

Both are opt-ins: the desktop's own host client, the Android client and every earlier iPhone build are sent exactly what
they were. Compressing phones' messages, the larger cut, stays a later change with its own device verification, and so
does sending a phone only the threads it shows first.

Replaying the laptop's captured hello through the listener, a phone connect fell from 4,510 KB to 2,257 KB, and from
7,994 KB to 4,277 KB with a `shell` read; hello from 2,768 KB to 1,978 KB and the first push from 1,742 KB to 279 KB. The
replay's before matched the installed laptop's within 1% (`docs/perf/2026-11-01-phone-connect-size.md`).
