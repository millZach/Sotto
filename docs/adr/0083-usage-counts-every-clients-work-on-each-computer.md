# Usage counts every client's work on each computer

Accepted October 14, 2026. Zach overruled ADR-0078's boundaries after the first Usage build showed almost nothing for any date range: it had begun dating work only when it was installed, left ten billion older tokens undated and outside every range, counted none of the subagents Sotto's threads started, listed one model twice, and could not read Claude's limits until a Claude turn happened to mention them. He asked for all of his usage in the selected period, and chose to count everything each computer's provider clients did, in Sotto and outside it, with Sotto's share told apart. This supersedes ADR-0078's scope, its history, prompt and model rules and its Claude-limit sentence. Everything this record does not change stands.

## What Usage counts

Usage counts the work each computer's Claude Code and Codex clients did, wherever it was sent from: Sotto's threads, the subagents those threads started, and the same clients used outside Sotto on that computer. Work **outside Sotto** is named by the app that sent it, as the provider's own records name it: Claude Code itself, the Codex app, the Codex CLI, `codex exec`, Codex in VS Code, T3 Code and the Codex plugin in Claude Code. Sotto never guesses an app from what was said.

The figures come from each client's own local records on the computer that ran the work: Claude Code's session transcripts and Codex's session rollouts, which carry each request's instant, served model and token counts. Sotto reads them on that computer, keeps the numbers, instants, model names and app names, and drops everything else in the same pass. No line, path, title or prompt is kept, logged or sent anywhere, and nothing new leaves the computer. The host reads them in the background five seconds after it starts, every five minutes and when Usage is opened, and each pass resumes where the last stopped in each file, so after the first it reads only what was added. Subagent work arrives through these passes rather than live.

A request Sotto already counted is the same request in the client's record, matched by the identity Sotto already used (Claude's message ID, Codex's turn and its running totals), so it gains its date instead of being counted again. A copy of history that a forked or subagent Codex session begins with is skipped, and repeated records count once.

Codex work Sotto started that no thread owns any more, such as a deleted thread or a side call for a title or branch name, is Sotto's work too, counted in tokens and never as a prompt. Sotto's own prompts from before Usage began come from its thread store: each stored user message, with its instant and whether it was a wake-up. Prompts outside Sotto are the clients' own user turns: a Claude Code message typed into a session, and a Codex turn, which includes each `codex exec` run. An agent can start those runs; Usage counts them as prompts and names the app, because the record cannot tell who typed them. Subagent work counts in tokens and never as a prompt.

Grok Build and Devin keep no token counts on the computer, so their work outside Sotto is not counted; their Sotto threads count as before. Muse and OpenCode are counted in Sotto's threads only (amended October 21, 2026, below). Work a client deleted from its own records, and Sotto threads deleted before Usage began, cannot be read back. A computer's history appears once its own Owl host carries this importer.

## Models

A prompt counts under the model that served it: the first token report after it in the same thread or session, else the model selected when it was sent. Every model is counted under one spelling, without Claude's context suffix or dated spellings, so a prompt sent on `opus` and the tokens Claude reports for `claude-opus-5-5` are one row.

## Subscription limits

Claude Code's limits are read when Usage opens and when Read again is pressed, through Claude Code's own `get_usage` request on the stream-json connection Sotto already uses: a running thread's connection when there is one, otherwise a short metadata-only process like the one that reads its model list. It sends no prompt, Sotto reads no credentials, and Claude Code talks only to its own provider, as it does for every thread. The request is marked experimental by its maker; a client without it falls back to the limits Claude Code reports during work. Window names say their length ("5 hours", "Week"). An expired window is not shown as current, and extra usage is shown only when it is turned on.

Muse's are read through its own `usage/read`, and OpenCode has none to read (amended October 21, 2026, below). Limits are still per provider and per computer and never added together. A host from before this record does not advertise `usage-history`; the desktop then leaves out the place and window filters its stricter query would refuse, and shows that host's figures as Sotto's own work. When several computers read one provider, Subscriptions shows the freshest reading and the others as a line each.

## What stays

ADR-0078's numeric-only store on the computer that owns the work, its independence from Keep local history, thread deletion and rewind, Clear usage and its revision guard, the Owl gate, the host capability negotiation and the per-computer reading through existing host connections all stand. Clear also keeps old records out of the importer: a record from before the clear instant never returns.

## The design

The page follows the C · Focus design Zach chose for ADR-0078, rebuilt with his real numbers and checked by him on October 14, 2026. For telling Sotto's share apart he chose **3 · Where view** of three treatments: an Everywhere / In Sotto / Outside Sotto menu that every number follows, a "Where" headline, and a **Where you work** view with one bar per place, Sotto's subagents on their own bar. The prototype called the third choice Elsewhere; it reads Outside Sotto because first-run setup already uses Elsewhere for its group of other computers and the iPhone. The approved prototype embeds his real usage figures, so it is kept on his computer rather than published; the C · Focus prototype it extends stays under the `prototype/usage-dashboard` tag.

## Amended October 21, 2026: Muse and OpenCode

Zach decided on October 21, 2026 that Usage counts Muse and OpenCode work in Sotto's threads: their accepted prompts under the model that served them, and the tokens their clients report for each model call or step, so their models appear in Overview, Models, Where you work and the daily series. Neither has a history import of work outside Sotto: Muse's session log is undocumented, and ADR-0087 keeps Sotto out of the user's own OpenCode folders. Muse's subscription limits come from Muse's own `usage/read`, a 5-hour window and a week. OpenCode reports none, so it is left off Subscriptions entirely. ADR-0079 and ADR-0087 record how each adapter does it. Each provider's usage exists only where its own Owl gate and Usage's are both on.

A desktop or host from before this amendment reads provider IDs against the four it knew and refuses a whole read or query naming another. The new host feature `usage-muse-opencode` says a peer knows Muse and OpenCode. A desktop names neither to a host that does not offer it. A host reads a desktop whose hello does not accept it for the four providers alone, so its totals hold only work that desktop can name, and leaves every Muse and OpenCode row out of what it sends, the way `usage-history` keeps place rows from a desktop from before history import.

## Splitting the Per day chart

October 21, 2026. Zach asked to switch the Per day chart between bars and lines and to compare models on it. Of three prototypes he picked **C · Split the chart** over A (toggle chips under the chart, one per model) and B (comparing checked models in a chart above the Models table). The prototype is kept as the tag `prototype/usage-compare-models`.

Prompts and Tokens each get **Show** (Total, By provider, By model) and **Bars | Lines**. By provider draws every provider with activity in the range. By model draws the top five models by the stage's own measure, prompts on Prompts and input plus output tokens on Tokens, and an **Other** series for the rest, worked out per day as the total less the drawn models, never below zero, and left out when there is no rest. Bars stack, so a day stays as tall as its total and still shows who filled it; lines are never stacked, because a stacked line reads as a total and hides the series being followed. A provider has one colour wherever it is drawn, and a model keeps its colour while it stays drawn. The choice is remembered while Sotto runs and is not a setting.

The page's read carries daily totals only, so each drawn series is one more read filtered to its provider or model, the way a model's details already were, made only while a split is shown. A filtered read is drawn only when it answers for every computer the page's own figures came from, each with all its days; otherwise it counts as failed, so a missing computer is never drawn as zero or handed to Other. Each series keeps whether its token figures were reported in full, in part or not at all, and the value list shows them as the rest of Usage does. The series colours are new: `--tt-chart-1` to `--tt-chart-6` and `--tt-chart-other`, constants per mode beside the provider marks in `tokens.css`, since a theme carries T3 Code's roles and none of them is a categorical hue. Each is at least 3:1 on every built-in theme's room and surface, and every pair, Other included, stays apart for protanopia and deuteranopia; `themeTokens.test.ts` holds both.


## Amended October 23, 2026: reading Grok's limits without starting Grok

Grok Build's limits come from its own `_x.ai/billing`, which once started a new Grok process for every read. On a busy Windows computer starting that process held main for one and a half seconds (#1456). A read now asks a Grok thread's own process that is already running and signed in, the way Claude Code's limits are read on a running thread's connection. The request names no session, and Grok already answers history reads on a thread's process beside its running prompt, so it disturbs no turn; a reply Sotto cannot read fails the read and leaves the process running. A running process has five seconds to answer before a process is started to ask instead, so a remote host's whole refresh still fits the desktop's 15-second call deadline; the late reply is ignored and the thread carries on. When no process is running, the refresh Usage makes on its own when it opens takes a good Grok reading from the last five minutes, shown with the time it was read, and only an older or failed one starts a process for the one question. A live read that failed is never covered by an earlier reading: it is shown as failed. Reads can now overlap, so a read that began earlier and finishes later never replaces a newer one's answer, in the adapter or in Usage's own cache. Read again always reads afresh. Usage refreshes on its own only readings over a minute old, so a shorter window would never be used. A host carries the difference with the host feature `usage-background-refresh`: a desktop marks only the refresh it made on its own, strips the mark for a host that does not list the feature, and such a host reads that refresh afresh as before. No quota read creates, loads or prompts a session.

## Amended October 27, 2026: starting Grok for its limits off main

The October 23 change left one read that still starts a process: one made with no Grok thread's process running and no reading young enough to reuse. A 60-second profile of main on 0.1.41-owl.20261027.3 under Windows 11 caught Usage's own refresh holding main for 838 ms in that start. On Windows a process starts on the thread that asks for it, and on this computer the first start in a while of Grok Build's binary (`~/.grok/bin/grok.exe`, 176 MB and unsigned) took 1.0 to 1.2 seconds while Windows checked it; the next start of the same file took about 4 ms. A fresh copy of the file read from memory still took 1.16 seconds to start the first time, so the cost is the check on starting, most likely Defender's real-time scan, not reading the disk.

That start now runs on the Git launcher's worker thread (`gitLauncher.ts`), which already starts Sotto's own Git and gh processes for the same reason. The launcher gained interactive launches: standard input stays open, main's writes reach the process in order, and what it prints comes back as it prints it. The JSON-RPC exchange, its deadlines and its checks stay on main in `GrokRpc`; only the start moved. Asking a running thread's process first, reusing a reading under five minutes old for Usage's own refresh, keeping the newer of two readings, and closing a probe on disconnect are unchanged, and so are what Usage shows and when it reads. Where the worker cannot be had, as when its file is missing, the probe starts on main as before.

Claude Code's limits probe starts the same way. When Usage reads Claude's limits with no Claude thread's runtime to ask, or one that went away or refused, Sotto starts Claude Code for one `get_usage` request, and that start also ran on main: on this computer the first start in a while of a fresh `claude.exe` (299 MB, signed) held the thread that asked for 655 ms. The probe now starts through the same interactive launch. Its flags, environment, folder, 15-second deadline, output cap, kill on the deadline or when nobody waits, sharing of concurrent reads, and no longer asking once Claude Code refuses are unchanged, and so is trying a running thread's runtime first.

Thread processes, the check when Grok connects, the check after a client update and side writing still start Grok on main, as the other providers' thread processes, Claude's among them, do. Moving those is separate work.

## Amended October 27, 2026: Usage's store runs off main

Opening Usage held main for about five seconds on Zach's computer: `usage:read` queried a 326 MB `usage.sqlite` (511,000 token rows, 12,600 prompts) synchronously on main, 2.5 seconds for the page's read and a few hundred milliseconds more for each provider's and model's read after it. Main is the window's thread, and the work grew with history. Every read and write of Usage's store now runs on the **usage store worker**, two worker threads started from one built file beside main's bundle and the headless host's, `usageStoreWorker.js`, built on its own the way the thread store's worker is (ADR-0016, October 26 amendment). The writer is the only connection that writes: it opens and migrates the file, flushes live tokens and prompts, recovers pending prompts, imports history and clears. The reader answers the page's reads on a connection opened read-only. They are separate so no write waits behind a read. Main keeps the buffer and the rules it always had and hands the store requests (`usageStoreRequests.ts`); where the worker file is not built, as under the test runner, the same requests are answered on main inside the call, as before.

What main relied on, kept:

- **Reads see what came before them.** A read waits until every flush handed over before it has been answered by the writer, then reads on the reader.
- **The original selection is written right after the send, never before** (ADR-0078, October 27 amendment). The send hands it to Usage without waiting, after the same check that it may send, so a send the coordinator refuses writes nothing. The selection goes in the next flush, and flushes commit in order, so it is always written before the echo that accepts it. A send did wait for it at first; during a history import that was 250–300 ms at the median on a copy of Zach's store, so Zach chose on October 27, 2026 that sends never wait for Usage. If Sotto crashes between the send and that write, the prompt can be counted under the model the provider reports rather than the one selected, or missed; nothing else is lost. A usage failure still never refuses or resends a message. The writer answers strictly in the order asked: letting a live flush go ahead of history batches queued before it was tried, and a history batch could then overwrite newer live figures for the same request with older ones.
- **Failure and retry.** A flush that fails keeps the record that failed and everything after it buffered, in order: the writer refuses every flush behind a failed one untried until main sends the retry, and main puts what came back ahead of what arrived since. A history pass's rows and cursors after one of its writes failed are refused there too, so no cursor moves past rows that did not go in. **Failed** and **lost** mean what they meant.
- **Clear** is refused unless everything buffered before it was written, and its revision is checked on the writer, in the same transaction as before.
- **Quitting** waits for the writer to commit what was handed to it, five seconds at most (`usage-store-close-timed-out`), then closes the file. What is unwritten then costs usage figures alone.
- **A worker that goes** logs `usage-store-worker-lost`. Its unanswered requests fail as a failed save would, and the next request starts a worker again. Writes are idempotent by identity, so writing again what it had committed counts nothing twice; a Clear it had not answered reports that Usage could not be saved.

A history pass reads every file's cursor once as it begins, rather than one file at a time, and waits after each file while more than four of its batches are on their way to the writer, so a first import never hands the worker a whole history at once. Which model served each prompt is now worked out once per revision rather than once per read, and the reader keeps the answers to the last sixteen different reads at one revision; on a warm copy of Zach's store a provider's read went from 210–245 ms to 90–125 ms, and the page's first read stays about 400 ms, now off main. What Usage shows is unchanged.

## Amended October 30, 2026: each thread's usage ledger has a file of its own (#555)

The usage a thread shows, its requests, totals and the keys that keep a replayed request from counting twice, was kept
for every thread of a provider in one file, `{provider}-usage.json`. A reply reports usage on nearly every frame, so while
one streamed the file was written about once a second, and each write synced all of it to disk: 2.4 MB on forge's host
and 12.7 MB on the owner's computer, for one thread's change. Since #1451 only the changed thread was encoded again, but
the whole file was still written.

- **The files.** Each thread's ledger is a file of its own in `{provider}-usage/`, named by a hash of its Sotto thread ID
  and holding `{ "id", "ledger" }`, compact. A write writes the threads that changed. What a ledger holds, and when it is
  written, are as before: at most once a second while a reply streams, at once when a turn ends or a compaction is
  recorded, a failed write shown on its thread until a later one lands, and the latest counts written when Sotto quits.
- **The one file of earlier builds** is read at start beneath the threads' own files, which win for their thread. Every
  ledger only it held is written to a file of its own, and once none is left only there the file is removed. A crash
  before then reads both again.
- **An earlier build** finds no shared file once it has been moved across, and counts each thread's usage afresh. Back on
  this one, a thread's own file is read over what that build counted for it, and a thread that build alone counted is
  moved across.
- **What stays.** Every request ever counted is still kept, so lifetime totals and replay deduplication are exact. #555's
  retention policy is still open; a file per thread lets one apply per thread.

On `usageStreamWrites.perf.test.ts`, a reply streaming 150 usage frames over a 3.8 MB ledger of forty threads wrote
19,004,865 bytes in five writes before and 473,680 in five after, in each of three rounds
(`docs/perf/2026-10-30-usage-ledger-per-thread.md`).
