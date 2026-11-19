# The referee harness

Issue #2688, stage 0 item 3 of the move to Rust (`docs/plans/2026-11-14-rust-native-port.md`, in #2687). The rule it serves: the TypeScript host is the referee, and a host in another language has to match it at the socket before it replaces it. This is the means of checking that. No Rust host exists yet; this note says what one must do to be checked.

It has two halves. The recorded frames (#2696): a script played against a host and compared with what the TypeScript host sent. And the adapter contract across the socket (this note's second part): `tests/integration/adapterContract.ts`, every adapter's behavioural contract, run against a host started by a command line instead of an adapter in process.

## What it does

`tests/integration/refereeReplay.test.ts` starts a host by a command line, once for each provider that has a fake program, and plays the same script against it (`tests/referee/scenario.ts`):

- Three clients pair over HTTP and open sockets at once, each with the hello a real client of its kind sends: the desktop's (`socketHostService.ts`), the iPhone's (`IncomingFrame.swift`) and a plain version 1 client that accepts only the OpenCode and Cursor provider features, without which a host hides those two providers from it. The desktop and the iPhone offer compression as they do.
- They take turns: the desktop turns the provider on, connects it, adds a project and makes a thread, and every client observes it. Then a turn from the desktop, a question from the iPhone and its answer, a permission from the plain client and its allowing, a stop from the desktop, a `detail` read from two clients, an `events` read and a `shell` read, an operation the host does not have, and a command field the allow-list lacks.
- The fake provider plays its part through its own control file (`tests/referee/providers.ts`). The driver finds the fake's session through the host's `threads.json` and the adapter's `<provider>-threads.json`, which every host keeps the same way, and never calls into the host.

Every message in both directions is kept. What a host sent is compared with `tests/referee/recordings/<provider>.json`, which the TypeScript host recorded.

Each provider is also played four shorter scripts, each its own recording, `<provider>-<script>.json`, after the same opening (the hellos, the provider on and connected, the project, the thread, every client observing):

- `lost-acknowledgement`: the fake is told to acknowledge the next prompt a second after its adapter stops waiting, the desktop sends, and the fake then ends the turn. Only where the fake does this through its files alone: Codex, Claude Code, Muse and OpenCode. Grok Build's, Devin's and Cursor's fixtures lose an acknowledgement by shortening their adapter's deadline in process, which no fake can make a host do.
- `attachments`: the desktop stages a text file (`stage-file-part`) and sends with it; the fake ends the turn.
- `pictures`: the desktop stages a picture (`stage-attachment`) and sends with it. Grok Build's and Devin's fake models read no image, so there the host refuses the send whole, saying so, and that refusal is what is recorded.
- `restart`: during a turn, the host process is stopped and started again over the same data folder; every client opens a new session with its pairing's token, says hello and observes again, and the fake ends the turn. After a restart Cursor's host sends the stopped turn Sotto's resume note (ADR-0076) as a turn of its own, which the fake ends too.

Three of these do not play the same way twice on the TypeScript host, so they are written and held out of the replays until their issue is fixed (`HELD_OUT` in `scenario.ts`); a replay says it skipped each and why. A held-out list is wider than the providers each fault was seen on, where the fault is in what the host publishes rather than in an adapter: the picture's changed repeat came from the host's detail pushes, which every provider goes through, at rates (one in four to one in six) that a handful of clean recordings for another provider does not rule out, and what a restart does to a stopped turn is the coordinator's, whichever provider runs it:

| Script | Held out for | Why |
| --- | --- | --- |
| `restart` | every provider | After the host starts again, whether the turn the restart stopped is sent the resume note (ADR-0076), and whether it goes before or after the clients observe the thread again, differ from run to run (#2710). It was first held out for a stale delta after the restart (#2700), which is fixed. |
| `pictures` | Codex, Claude Code, Muse, OpenCode, Cursor | After a send with a picture, the host can send the whole detail again at the revision the client holds, with the picture's preview added (#2699). Grok Build's and Devin's refusals are replayed. |
| `lost-acknowledgement` | Claude Code | Once the turn whose acknowledgement came late ends, the thread's summary counts one activity in some runs and none in others, with the same detail (#2698). |

The providers recorded are Codex, Claude Code, Grok Build, Devin, Muse, OpenCode and Cursor: every provider a host takes that has a fake program. Hermes is a host provider with no fake program yet, so it has no recording. Pi and DeepSeek Harness are held on every host (ADR-0138, `heldOnHost`), so a host starts nothing for them and there is nothing at the socket to record.

Nothing in a recording comes from a real account. Every prompt, reply, question and permission is the script's own text, and the fakes answer from their own fixtures. The referee host reaches no registry, runs no installer and looks for no client on the machine's PATH, so a recording says nothing about the machine that made it.

## How it compares

The host coalesces its shell and detail pushes on a 50 ms window (`statePublishers.ts`), so how many of them cross between two points, and which states in between they show, depends on timing even for the TypeScript host against itself. The protocol promises only the newest state. So the referee compares two things at the end of every step, for every client:

- **Frames compared one by one, in order.** Every answer and every push other than `shell`, `detail` and `detail-delta`. A shell inside an answer is put back whole first (its catalog by revision, its thread records with `command-changed-thread-records`).
- **What the client holds.** `shell`, `detail` and `detail-delta` pushes are folded the way the desktop's and the iPhone's clients fold them (`tests/referee/fold.ts`): kept parts put back, thread records put back from the push they were measured from, a catalog left out found by its revision with the provider mode lists that went beside it, each model's modes put back from those lists, and each delta applied to the revision it follows. The newest shell, each thread's detail and every event the client was sent are compared whole.

Each frame is also read strictly as it arrives, and one a client could not have read fails the run, however the end state looks: a frame not on `v: 1`, kept parts or thread records measured from a push the client did not apply, a catalog revision it was never sent, a model naming a provider mode list the shell does not carry, a delta that does not follow the revision held or that repeats one it holds, a whole detail older than the one held or at the revision held with anything different in it (the host may send the one held again, #2699), an event that arrives twice or out of order, and an `observe` answered before the threads it names were pushed, which the protocol promises the other way round. A frame compared one by one that arrives after the last step fails too, and the socket's upgrade must carry the right `Sec-WebSocket-Accept`.

When recording, a step is over once every client holds what the step waits for: the last thing the step changes, written in the script (a command's lane closing, a send's turn record opening and its delivery acknowledged, a turn's records closing, a permission's side summary arriving). Each was found by watching every step for 1.5 seconds after its condition held and adding what still changed, until nothing did for any provider; that watch was a tool for finding them and is not in the harness. When replaying, a step is over once every client holds exactly what the recording holds and has been sent as many frames; nothing waits on a clock. A host that never gets there fails at the step's deadline, 20 seconds, with the difference.

Before the recorded clients connect, one more client says hello and waits for the host's start-up to settle (its provider connected, none still connecting, its client read for updates). A host says it is ready before its providers connect, and a hello answers whatever the host holds at that moment, so without this the first hello would record how fast the machine was. That client's frames are not compared.

## Normalisation

Every rule is in `NORMALISATION_RULES` in `tests/referee/normalise.ts`, with its reason. Each one is a place a wrong host could hide a wrong value, so each covers only the difference it was found for:

| Rule | What it replaces, and why |
| --- | --- |
| folders | The run's data folder and the checkout, written `<data>` and `<repo>`: both differ between runs and machines. |
| ids | Every UUID, and the OpenCode fake's own IDs (a short prefix, an underscore and 26 hexadecimal digits), written `<id:N>` by where each first appears. A value that names the same thing twice still has to. |
| digest IDs | 64 hexadecimal digits that end an ID after a word and a hyphen (`codex-activity-…`, `grok-request-…`, `muse-approval-…`, `grok-assistant-…`): adapters hash the provider's random IDs. A digest that stands alone, such as an attachment's, is kept. |
| detail revisions | A thread detail's `revision` counts the host's updates, which depend on how the provider's events were batched. The fold still checks revisions only increase and every delta follows. |
| catalog revisions | `host.modelsRevision` counts catalog changes, which differ while providers connect at start. The fold still checks every catalog left out names one the client was sent. |
| answer echoes | In the answer to a `manual-send` only, a thread record's `lastUserMessageId`, `lastTurn`, `activities` and `summary`, and for OpenCode its `status`: the provider's acknowledgement writes them before or after the answer is read (OpenCode's status is the contract's `sendAnswerRunning`). The same fields are compared in what every client holds at the step's end, and every other command's answer is compared whole. |
| stale running turn | `summary.runningTurnStartedAt` on a thread record whose status is not running (#2697). See the findings. |
| empty monitoring | `monitoring: []` on a thread record, which means what no `monitoring` means (#2698). See the findings. |
| key order | Object keys are sorted before anything is named or compared: JSON objects have no order, and the host builds some differently from run to run. |
| times | ISO-8601 instants, and numbers between 10^12 and 10^13 (milliseconds from 2001 to 2286), written `<time>`. |
| latencies | A delivery's `localFeedbackMs` and `providerLatencyMs`, and no other field, written `<ms>`. |
| secrets | The pairing code, token, session and admin bearer, written `<secret>`. |
| listener | Health's `port` and `pid`. |

Two fakes were changed so that their own IDs do not differ between runs where nothing else does: the Devin fake no longer puts its process ID in the IDs of the requests it sends (it uses a random token, which the ids rule covers), and the Codex fake is told a request ID base through the script file it already reads.

## What the TypeScript host does differently from run to run

These were found by recording every provider four times and comparing the recordings field by field. They are the host's, not the harness's:

1. **Shell and detail pushes are coalesced on a timer**, so their number and the states in between differ from run to run. By design; the referee compares what they leave the client holding.
2. **A command's answer shows the thread before or after the provider's acknowledgement.** The answer to a send can carry the previous turn's `lastUserMessageId` and `lastTurn`, or the new ones, and for OpenCode the thread idle or running. The `answer echoes` rule covers the fields seen to differ, in send answers only; any other field, and any other answer, is compared.
3. **Claude Code's event history is not the same on every run.** The adapter hears a reply twice, from the CLI's output and from its transcript, and when the transcript wins the thread's history gains a `message-replaced` event that repeats the message word for word: the same script gave 9, 10 and 11 events. The referee does not normalise this away. Claude's script leaves out the `events` read, with the reason in `scenario.ts`, until the adapter is settled one way (#2698).
4. **A thread's summary can keep `runningTurnStartedAt` after its turn ended**, until the thread next changes; on other runs it is cleared with the turn. Seen with Codex and Claude Code. A client could show a running timer on an idle thread. The rule leaves the field out only where the thread itself says it is not running (#2697).
5. **Claude Code writes `monitoring: []` or leaves it out**, depending on whether it last read the thread from the CLI's output or its transcript. A client reads both the same (#2698).

The shorter scripts and the contract across the socket found four more:

6. **A whole detail can come again at the revision the client holds** (#2699). After a send with a picture, Codex's host sent it again with `messages[0].attachments[0].preview` now `{ "available": true }` and the revision unchanged, in two of about seven recordings, and Cursor's in one. After a Devin send with a text file and a PDF, it came again identical, right after the delta that brought the client to that revision, every time. The fold takes an identical repeat, which changes nothing a client holds, and fails a changed one. So a host may send that repeat or not and match: the same latitude the fold already gives the number of coalesced pushes, since a repeat is one more push that leaves the client holding the same.
7. **After a restart, a delta could follow that did not follow the detail an observe just sent** (#2700, fixed). The iPhone client held revision 2 and was sent deltas from 1 and 3, or held 3 and was sent one from 2, and the thread was not sent whole again: once in six Codex recordings and once in four Cursor ones. The cause was the host's 50 ms detail window (`statePublishers.ts`): a change waiting out the window when an observe read the thread whole is behind that whole, the next change joins it, and the delta that went started before what the client held and ended past it. `sendUpdate` in `socketServer.ts` sent it anyway and then knew no revision for the client, so it sent every later delta too and never the thread. It now sends the thread whole in its place, as it already did for a held delta a read had overtaken. Only after a restart do clients observe a thread while it is still changing, which is why the other scripts never showed it. With the fix, 31 recordings of the `restart` script, each frame read strictly, found no delta that did not follow: Codex and Cursor 13 times each and the other five providers once, where before it one of the three runs of Codex and Cursor that finished had one.
8. **Claude Code's summary counts a late-acknowledged turn's activity or not** (on #2698): `summary.activityCount` was 1 or 0 with the same detail, in 3 of 5 replays.
9. **What a restart does to a running turn is the coordinator's, and is not the same from run to run** (#2710). With #2700 fixed, the `restart` script still did not replay: six Codex recordings brought the thread back idle with no resume note, a seventh sent the note after the clients observed the thread again, and a replay against that one had sent it, with the thread running, before the last observe was answered. Replayed against a fresh recording of every provider, all seven failed their first run there. So the script stays held out under that issue. Across the socket, a Codex thread running when its host stopped came back idle without `runningTurnStartedAt`, and a Claude Code one came back with a turn record its adapter alone does not have; Cursor's was sent Sotto's resume note (ADR-0076) as a new turn. Each outcome is the coordinator's to choose, and they are why the contract's restart case cannot cross (below); what the replays cannot take is that the choice differs between runs.

`docs/host-protocol.md` and the host agree on everything the scripts exercise but one: `observe` says a thread a client holds is not sent again unless its push did not fit or its delta did not follow, and finding 6 is the host sending it again where neither was so. The document is left as it is until #2699 settles which is right. Finding 7 was a second: the same section says a thread whose delta did not follow is sent again, and after a restart it was not (#2700); the host now does what the document says. The rest agrees: the HTTP answers' fields, the compression answer to both offers, hello's fields, `observe` pushing before it answers, the two refusals being `invalid_request`, staging's answers, the refusal of a picture to a model that reads none, and the shapes of the reads.

## Evidence on forge

- Four recordings of every provider, made one after another, are identical after normalisation.
- The Node host replayed against its own recordings 20 times for each of the seven providers, 140 runs, with no difference: `SOTTO_REFEREE_REPEAT=20 SOTTO_REFEREE_SCENARIOS=main npx vitest run tests/integration/refereeReplay.test.ts --maxWorkers=2`, 7 passed in 341 seconds, on November 19, 2026, with forge's load average near 10 from other work, on the commit this note ships with. The first such pass failed once in 140, on Devin's third run: a shell that named its catalog by revision left out the provider mode lists that go with it, and the referee's fold put the catalog back without them. The fold now holds the lists with their catalog and puts each model's modes back as the clients do; a second pass then matched all 140, and the third, above, came after the review's changes (send answers alone lose their echo fields, a whole detail may not repeat the revision held, every frame is on `v: 1`).
- Three hosts changed on purpose fail (`tests/integration/refereeTamper.test.ts`), and say so:
  - A host that leaves `title` out of every thread record it pushes to the desktop: `Step 7 (desktop makes the thread), desktop, what the client holds once the step is over: at shell.host.threads[0].title: recorded "Referee thread", this host sent no such field`.
  - A host that answers the iPhone's `observe` before pushing the thread: `Step 9 (iphone observes the thread), iphone: The host answered observe before it pushed thread 00000000-0000-4000-8000-00000000000a.`
  - A host that sends the desktop one detail delta twice: `Step 11 (desktop sends "Referee prompt one"), desktop: A detail delta to revision 3 arrived for thread 00000000-0000-4000-8000-00000000000a, whose revision 3 the client already holds.`

The recordings are committed in a compact form, 944 KiB for the seven: a shell inside a frame is stored as the changes from the shell the client held when the step began, and what a client holds as the changes from the step before. A replay puts both back before comparing, so nothing is lost.

## The adapter contract across the socket

`tests/integration/socketAdapterContract.test.ts` runs `describeAdapterContract`, the contract every adapter passes in process, for each of the seven providers against a host started by its command line, the same one the replays start (`SOTTO_REFEREE_HOST`, or the Node referee host). Nothing in it calls into the host:

- **The host** is a paired client of it (`tests/referee/socketAgentHost.ts`), an `AgentHost` that says hello with the desktop's list, holds the shell and the observed threads' details as the pushes leave them (the replays' fold, so every push is still read strictly), takes a command's answer as the state it shows, as the desktop's client does, and sends only commands and fields `src/host/remoteCommands.ts` takes from a paired client.
- **The driver** is each provider's own fixture driver, the one the contract uses in process (`tests/referee/fixtures.ts`), made over the host's data folder and never connected. It writes the fake's control and script files and reads what the fake recorded, in that folder; a driver call names a thread by the adapter's own ID, which the host's `threads.json` binds to the Sotto thread. Codex's and Claude Code's drivers also ask their own adapter to read the session log they just wrote; across the socket the host's adapter reads it on its own timer, so that call is dropped.
- **A restart** is the host process stopped and started again over the same folder, and a new session opened with the pairing's token.

The socket is the coordinator's boundary, not the adapter's, so each adapter command goes as the client command that does the same, and comes back as a client reads it. A project's ID is the host's, so the contract's own is given back in its place. A send names no message ID on the wire, so it goes as `manual-send` with a draft ID; the delivery for that draft names the message the host made, which is given back under the contract's ID, and says what the send's result is: `accepted`, or `uncertain`. Staged attachments go by `stage-attachment` and `stage-file-part` first, and their handles come back under the contract's IDs. A thread's messages are its detail's. A title the contract gives a thread goes as `titleSource: user`, since the coordinator renames only a thread whose title is its own. Project records lose the three fields the coordinator adds when it joins its providers' projects (`hostId`, `providerId`, `workspaceSettledAt`).

An adapter has done what a command asks once it returns; a host shows it in the pushes that follow. So the client waits, as the referee's steps do, for named things it can see, never a clock: a connect until the provider is connected with start-up over, no command in its lane and each observed thread's detail held; a send until its delivery is settled, the thread runs a turn and names the message as its last, the provider's acknowledgement is recorded, the lane is closed and an observed thread's detail holds the message. Each wait, and each driver action the fake has to carry out, fails with a sentence after 30 seconds, half a case's own 60.

### What crosses

Twelve of the contract's cases cross, 72 runs across the seven providers, and pass on the Node host. A blank is a case the provider's own fixture skips in process too, or one named for that provider below.

| Case | Codex | Claude Code | Grok Build | Devin | Muse | OpenCode | Cursor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| can compact exactly when its provider profile says it compacts (ADR-0095) | yes | yes | yes | yes | yes | yes | yes |
| creates projects and threads, streams replies, and transitions running to idle | yes | yes | yes | yes | yes | yes | yes |
| saves an attached file in the working folder and names it to the provider, with a PDF in the prompt where it reads one, and the thread shows only the user’s words (ADR-0131), across a restart | yes | yes | yes | yes | yes | yes | yes |
| shows a prompt the user typed in the note’s shape in full when it carries no attached file (ADR-0131), across a restart | yes | yes | yes | yes | yes | yes | yes |
| cancels a running turn | yes | yes | yes | yes | yes | yes | yes |
| keeps confirmed background work past the end of its turn until the provider ends it, and never restores it, across a restart | yes | yes | yes |  | yes | yes |  |
| routes a question and delivers its answer | yes | yes | yes | yes | yes | yes | yes |
| delivers an explicit permission decision (true), and (false) | yes | yes | yes | yes | yes | yes | yes |
| never approves a skipped permission when interrupted and disconnected | yes | yes | yes | yes | yes | yes | yes |
| reconciles an uncertain prompt acknowledgement without resending | yes |  |  |  | yes | yes |  |
| applies a change while background work runs, and the work carries on | | yes | | | | | |

Only Claude Code's fixture reads a session's count and live settings from the fake's files alone (`FILE_DRIVEN_SESSIONS`), so only it runs the live-settings case.

### What cannot cross

Each case below watches something inside the host that no client can see or send, or something the coordinator decides before an adapter is asked, so across the socket it would test nothing, or only the referee's own client. One, Cursor's lost acknowledgement, could cross and is left out for its cost, and says so. Each is in `CANNOT_CROSS` in `tests/referee/socketFixture.ts` with the same reason, and `refereeTamper.test.ts` checks this note names every one. None was changed to make it cross.

| Case | Why it cannot cross |
| --- | --- |
| keeps ordinary permissions when main supplies no Watcher profile | Launch profiles are main's, handed to the adapter in process (`useLaunchProfiles`); no client sends one. |
| observes provider takeover and rejects a reply based on stale user input | A client cannot name the user message its reply follows: the host works out `expectedLastUserMessageId` for itself, so no client can send a stale reply. The host service contract carries the takeover half across the socket. |
| marks the prompt written and its acknowledgement on the stopwatch lent for the send (#763) | The stopwatch is lent to the adapter in process (`lendSendStages`); a client sees only the delivery's `localFeedbackMs` and `providerLatencyMs`. |
| leaves a watched thread's messages out of the activity publications of a subscriber that keeps history from events (#322) | Activity subscribers are in process (`subscribeActivitySnapshots`); a client's shell never carries messages, whichever way it keeps them. |
| publishes every change to a thread as an upsert of it, keeping a thread map equal to the activity snapshot after each (#925)<br>keeps a thread map equal to the activity snapshot from before a thread is first created or read (#925) | Thread changes are an in-process subscription (`subscribeActivityChanges`) held in a `ThreadMap`; their form on the wire, changed thread records, is what the referee's replays hold a host to. |
| publishes a thread that went as a removal of it (#925) | Thread changes are an in-process subscription, and the case takes the thread's saved record out between two connections of the adapter, which a client cannot make without the host's coordinator reconnecting it. |
| hands a thread refresh back without messages to a caller that keeps history from events, and with them to any other (#368) | `refreshThread` and its read purposes are the coordinator's reads of its adapter; a client reads a thread with `detail`, which always carries its messages. |
| writes short text on the side, and the thread's own session never hears of it (ADR-0026) | The case hands the adapter a prompt and material of its own (`writeShortText`). A client can only ask the host for a title, whose material the host chooses, so the marker the case looks for cannot be put in. |
| sends a staged image through the handle contract, reading its bytes only at the provider boundary (ADR-0031) | It counts how often the handle's bytes are read inside the host. Across the socket the client reads them itself to stage the image, so the count says nothing of the host. |
| resumes the same thread and messages after restart during a run | It holds the adapter's restored thread equal to the one before, field for field. Across the socket the host's coordinator stands between them: it decides what a turn the restart stopped becomes (ADR-0076) and when a watched session opens again, so the thread a client is shown after a restart is the coordinator's. The referee's restart script holds a host to the TypeScript host's thread across a restart instead, once #2710 lets it be recorded; the attached-file cases here read messages back across one. |
| connects without starting a session, and starts one when the thread enters the watched set<br>starts a session for an action on a thread nobody is watching<br>starts a stopped session for an early start, says it is open, and the send that follows starts none<br>says a session the reaper stopped after an early start is no longer open<br>stops a session left idle and starts it again on the next send, with its messages<br>never stops a session with a running turn, while an idle one beside it is stopped<br>never stops a watched session, while an unwatched one beside it is stopped | Each case counts or checks a thread's provider session from the moment the thread is made, or waits for a reaper window it sets. A host makes the session on the thread's first send (the thread reads `nativeSessionStarted: false` until then, and `start-thread-session` on the wire starts one the way that send would), so there is nothing to count before it; the reaper's short windows (`reaperSweepMs`, `sessionIdleMs`) are the adapter's options, which no client sets; and every fixture but Claude Code's reads whether a session is open from its adapter in process. The host service contract's reaping case carries lazy sessions across the socket. |
| creates no provider session for an early start before a thread’s first send<br>creates no provider session for an early start before a thread’s first send, when its folder does not exist yet | An early start for a thread not made yet names its model and folder in process (`startThreadSession`'s draft); on the wire, `start-thread-session` names a thread the host already has. |
| hands the history to the event store, which answers for a thread nobody is watching | It runs the coordinator's event store (`WorkspaceHost`) over the adapter in process; across the socket that store is inside the host, and the host service contract reads its history from there. |
| applies each change to the running session without starting another<br>starts the session again when the provider refuses a change, and still ends accepted<br>leaves a change whose answer was lost unconfirmed, until the session that runs it starts | The case opens the thread's provider session by reading the thread (`refreshThread`) and changes its settings before anything is sent. A host makes the session on the first send, so the change is kept as the thread's settings and never reaches a session. |
| hands back the snapshot of a confirmed change, carrying the settings the adapter reports | The case changes a thread that has sent nothing. A host makes the provider session on the first send, so the change is kept as the thread's settings and never reaches the provider: across the socket the case would check only that the coordinator shows what it saved. |
| leaves the messages out of a confirmed change's snapshot for a caller that keeps history from events (#368) | A client cannot say how it keeps history: every shell leaves messages out, so the case's check would pass whatever the host did. |
| carries no snapshot on an uncertain change | The case changes a thread that has sent nothing. A host makes the provider session on the first send, so the change is kept as the thread's settings and never reaches the provider, and there is no confirmation to lose. |
| lets a working turn finish across the update, stays connected, and reads the new version from the client<br>does nothing while the provider is not connected | The case puts a newer client on disk and tells the adapter in process (`clientUpdated`). A host hears of a new client only from its own installer, which `update-client` runs on the host and no client may send (`src/host/remoteCommands.ts`). |

And for some providers only, where the fixture's driver reaches into the adapter it was made with:

| Provider | Case | Why it cannot cross |
| --- | --- | --- |
| claude | reconciles an uncertain prompt acknowledgement without resending | The fake holds the acknowledgement past the adapter's deadline, but the host answers the send accepted: by the time it answers, the prompt shows in the thread, and nothing on the wire says the acknowledgement was late. Codex's, Muse's and OpenCode's cross. |
| grok | reconciles an uncertain prompt acknowledgement without resending | The fake holds the acknowledgement 3 seconds, past a 2-second deadline the fixture gives its own adapter in process for that one prompt (`requestTimeoutMs`). The host's adapter waits its own 15 seconds, so the acknowledgement arrives in time and nothing is lost. |
| devin | reconciles an uncertain prompt acknowledgement without resending | The fake holds the acknowledgement 3 seconds, past a 2-second deadline the fixture gives its own adapter in process for that one prompt (`requestTimeoutMs`). The host's adapter waits its own 15 seconds, so the acknowledgement arrives in time and nothing is lost. |
| cursor | reconciles an uncertain prompt acknowledgement without resending | The fake drops the acknowledgement, and the fixture shortens its own adapter's wait for it to 2 seconds in process. The host's adapter waits its own 30 seconds before it calls the send uncertain, so across the socket the case would cost half a minute a run; it is left out for that, not because a client cannot see it. |

Cases a fixture skips in process (its `skips`, such as Codex's live settings) are skipped across the socket for the same reason.

## Pointing another host at it

```sh
npm run test:referee                       # the replays, the three changed hosts and the contract across the socket, on the Node host
SOTTO_REFEREE_HOST='["/path/to/sotto-host", "--data", "{data}", "--fake", "{provider}"]' \
  npx vitest run tests/integration/refereeReplay.test.ts tests/integration/socketAdapterContract.test.ts
SOTTO_REFEREE_PROVIDERS=codex,claude ...   # some providers only, in both
SOTTO_REFEREE_SCENARIOS=main,attachments ...   # some scripts only
SOTTO_REFEREE_RECORD=1 SOTTO_REFEREE_HELD_OUT=1 SOTTO_REFEREE_RECORDINGS=/some/folder ...   # record the held-out scripts elsewhere; replay them
                                           # from there, with SOTTO_REFEREE_HELD_OUT=1 and without RECORD, to see whether their issue is fixed
SOTTO_REFEREE_REPEAT=20 ...                # each script 20 times
SOTTO_REFEREE_RECORD=1 npx vitest run tests/integration/refereeReplay.test.ts   # record again, from the Node host only
```

`SOTTO_REFEREE_HOST` is the host's command line as a JSON array; `{data}` becomes the run's data folder and `{provider}` the provider whose fake it runs. Linux only for now.

A host under test must:

1. Take the data folder and the provider from its command line, keep all its files in that folder, and listen on loopback on a port it chooses.
2. Print the shipped host's ready line once it listens, `{ ..., "port": <port>, "event": "ready" }` on one line of stdout, write `host-listener.json` with its `adminToken` in the data folder, and stop on SIGTERM.
3. Report Sotto version `0.1.44-owl.20261118.2`, so every Owl feature is on and OpenCode and Cursor are hosted (`REFEREE_OWL_VERSION`).
4. Run the provider's adapter against that provider's fake as the Node referee host does (`tests/fixtures/refereeNodeHost.ts`, through each fixture in `tests/fixtures`): the fake is `node tests/fixtures/<fake> <data>`, started where the real client would be. Codex: `fakeCodexAppServer.mjs`, home `<data>/home`. Claude Code: `fakeClaudeThread.mjs`, home `<data>/home`. Grok Build: `fakeGrokThreadAgent.mjs`. Devin: `fakeDevinAgent.mjs`, config `<data>/native-config`. Muse: `fakeMuseAgent.mjs`. OpenCode: `fakeOpenCodeServer.mjs`. Cursor: `fakeCursorAgent.mjs`, config `<data>/cursor-config`. The Node referee host uses each fixture's own deadlines and poll intervals; those change when things happen, not what, and a host may poll at its own pace.
5. Hold every other provider, so its connect fails at once with the held provider's sentence (`<Provider> is available in Sotto Owl; it is not in this build.`), as `HeldProviderHost` does.
6. Ask no registry what a client publishes, run no installer, and find no client on the PATH: the client update line then reads each client as the Node referee host does.
7. Keep `threads.json` and `<provider>-threads.json` as the TypeScript host does, since the driver finds each fake's session there.
8. Keep its pairings in the data folder, so that after it is stopped and started again over the same folder a client's token opens a new session (the contract's restarts, and the `restart` script once it is recorded).

A failure names the step, the client, and the first places where what it holds or a frame differs, with the recorded value and the one this host sent, and keeps the run's data folder for a look.

## Not covered yet

- The contract cases above that cannot cross, and the three held-out scripts until #2699, #2710 and #2698 are settled.
- Hermes has no fake program, so neither half covers it. A fake is not small: Hermes's adapter speaks its own ACP dialect (`src/main/agents/hermes*.ts`, about 2,100 lines), so a fake needs its version handshake (`HERMES_ACP_VERSION`, `HERMES_CLI_VERSION`), session creation and loading, prompts with their streamed updates, permission requests and their answers, its models and its skills, then a fixture, the in-process contract passing, and a recording. Pi and DeepSeek Harness are held on hosts.
- Takeover typed in the provider (the contract's case does not cross; nothing records it yet), the step window's `earlier-steps`, sign-in, Git, Files and the other optional requests are not in a script yet.
- Windows and macOS: the recordings are made on Linux, and paths and the machine's facts would differ.
