# The referee harness

Issue #2688, stage 0 item 3 of the move to Rust (`docs/plans/2026-11-14-rust-native-port.md`, in #2687). The rule it serves: the TypeScript host is the referee, and a host in another language has to match it at the socket before it replaces it. This is the means of checking that. No Rust host exists yet; this note says what one must do to be checked.

## What it does

`tests/integration/refereeReplay.test.ts` starts a host by a command line, once for each provider that has a fake program, and plays the same script against it (`tests/referee/scenario.ts`):

- Three clients pair over HTTP and open sockets at once, each with the hello a real client of its kind sends: the desktop's (`socketHostService.ts`), the iPhone's (`IncomingFrame.swift`) and a plain version 1 client that accepts only the OpenCode and Cursor provider features, without which a host hides those two providers from it. The desktop and the iPhone offer compression as they do.
- They take turns: the desktop turns the provider on, connects it, adds a project and makes a thread, and every client observes it. Then a turn from the desktop, a question from the iPhone and its answer, a permission from the plain client and its allowing, a stop from the desktop, a `detail` read from two clients, an `events` read and a `shell` read, an operation the host does not have, and a command field the allow-list lacks.
- The fake provider plays its part through its own control file (`tests/referee/providers.ts`). The driver finds the fake's session through the host's `threads.json` and the adapter's `<provider>-threads.json`, which every host keeps the same way, and never calls into the host.

Every message in both directions is kept. What a host sent is compared with `tests/referee/recordings/<provider>.json`, which the TypeScript host recorded.

The providers recorded are Codex, Claude Code, Grok Build, Devin, Muse, OpenCode and Cursor: every provider a host takes that has a fake program. Hermes is a host provider with no fake program yet, so it has no recording. Pi and DeepSeek Harness are held on every host (ADR-0138, `heldOnHost`), so a host starts nothing for them and there is nothing at the socket to record.

Nothing in a recording comes from a real account. Every prompt, reply, question and permission is the script's own text, and the fakes answer from their own fixtures. The referee host reaches no registry, runs no installer and looks for no client on the machine's PATH, so a recording says nothing about the machine that made it.

## How it compares

The host coalesces its shell and detail pushes on a 50 ms window (`statePublishers.ts`), so how many of them cross between two points, and which states in between they show, depends on timing even for the TypeScript host against itself. The protocol promises only the newest state. So the referee compares two things at the end of every step, for every client:

- **Frames compared one by one, in order.** Every answer and every push other than `shell`, `detail` and `detail-delta`. A shell inside an answer is put back whole first (its catalog by revision, its thread records with `command-changed-thread-records`).
- **What the client holds.** `shell`, `detail` and `detail-delta` pushes are folded the way the desktop's and the iPhone's clients fold them (`tests/referee/fold.ts`): kept parts put back, thread records put back from the push they were measured from, a catalog left out found by its revision with the provider mode lists that went beside it, each model's modes put back from those lists, and each delta applied to the revision it follows. The newest shell, each thread's detail and every event the client was sent are compared whole.

Each frame is also read strictly as it arrives, and one a client could not have read fails the run, however the end state looks: a frame not on `v: 1`, kept parts or thread records measured from a push the client did not apply, a catalog revision it was never sent, a model naming a provider mode list the shell does not carry, a delta that does not follow the revision held or that repeats one it holds, a whole detail no newer than the one held, an event that arrives twice or out of order, and an `observe` answered before the threads it names were pushed, which the protocol promises the other way round. A frame compared one by one that arrives after the last step fails too, and the socket's upgrade must carry the right `Sec-WebSocket-Accept`.

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
| stale running turn | `summary.runningTurnStartedAt` on a thread record whose status is not running. See the findings. |
| empty monitoring | `monitoring: []` on a thread record, which means what no `monitoring` means. See the findings. |
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
3. **Claude Code's event history is not the same on every run.** The adapter hears a reply twice, from the CLI's output and from its transcript, and when the transcript wins the thread's history gains a `message-replaced` event that repeats the message word for word: the same script gave 9, 10 and 11 events. The referee does not normalise this away. Claude's script leaves out the `events` read, with the reason in `scenario.ts`, until the adapter is settled one way.
4. **A thread's summary can keep `runningTurnStartedAt` after its turn ended**, until the thread next changes; on other runs it is cleared with the turn. Seen with Codex and Claude Code. A client could show a running timer on an idle thread. The rule leaves the field out only where the thread itself says it is not running.
5. **Claude Code writes `monitoring: []` or leaves it out**, depending on whether it last read the thread from the CLI's output or its transcript. A client reads both the same.

`docs/host-protocol.md` and the host agree on everything the script exercises: the HTTP answers' fields, the compression answer to both offers, hello's fields, `observe` pushing before it answers, the two refusals being `invalid_request`, and the shapes of the reads.

## Evidence on forge

- Four recordings of every provider, made one after another, are identical after normalisation.
- The Node host replayed against its own recordings 20 times for each of the seven providers, 140 runs, with no difference: `SOTTO_REFEREE_REPEAT=20 npx vitest run tests/integration/refereeReplay.test.ts --maxWorkers=2`, 7 passed in 341 seconds, on November 19, 2026, with forge's load average near 10 from other work, on the commit this note ships with. The first such pass failed once in 140, on Devin's third run: a shell that named its catalog by revision left out the provider mode lists that go with it, and the referee's fold put the catalog back without them. The fold now holds the lists with their catalog and puts each model's modes back as the clients do; a second pass then matched all 140, and the third, above, came after the review's changes (send answers alone lose their echo fields, a whole detail may not repeat the revision held, every frame is on `v: 1`).
- Three hosts changed on purpose fail (`tests/integration/refereeTamper.test.ts`), and say so:
  - A host that leaves `title` out of every thread record it pushes to the desktop: `Step 7 (desktop makes the thread), desktop, what the client holds once the step is over: at shell.host.threads[0].title: recorded "Referee thread", this host sent no such field`.
  - A host that answers the iPhone's `observe` before pushing the thread: `Step 9 (iphone observes the thread), iphone: The host answered observe before it pushed thread 00000000-0000-4000-8000-00000000000a.`
  - A host that sends the desktop one detail delta twice: `Step 11 (desktop sends "Referee prompt one"), desktop: A detail delta to revision 3 arrived for thread 00000000-0000-4000-8000-00000000000a, whose revision 3 the client already holds.`

The recordings are committed in a compact form, 944 KiB for the seven: a shell inside a frame is stored as the changes from the shell the client held when the step began, and what a client holds as the changes from the step before. A replay puts both back before comparing, so nothing is lost.

## Pointing another host at it

```sh
npm run test:referee                       # the Node host against its recordings, and the three changed hosts
SOTTO_REFEREE_HOST='["/path/to/sotto-host", "--data", "{data}", "--fake", "{provider}"]' \
  npx vitest run tests/integration/refereeReplay.test.ts
SOTTO_REFEREE_PROVIDERS=codex,claude ...   # some providers only
SOTTO_REFEREE_REPEAT=20 ...                # each provider 20 times
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

A failure names the step, the client, and the first places where what it holds or a frame differs, with the recorded value and the one this host sent, and keeps the run's data folder for a look.

## Not covered yet

- `tests/integration/adapterContract.ts` across the socket, item 3 of the issue, comes in the next pull request.
- Hermes has no fake program; Pi and DeepSeek Harness are held on hosts.
- A host restart, a lost acknowledgement (`delayNextAck`), takeover typed in the provider, attachments, the step window's `earlier-steps`, sign-in, Git, Files and the other optional requests are not in the script yet.
- Windows and macOS: the recordings are made on Linux, and paths and the machine's facts would differ.
