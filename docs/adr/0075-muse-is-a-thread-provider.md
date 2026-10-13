# Muse is a thread provider

Accepted October 12, 2026. Zach chose the release shape the same day: an Owl feature (ADR-0072), a full Threads provider rather than a thread-only minimum, Muse's own sign-in with no key in Sotto, and paired hosts and the phone clients included. The wire facts below were checked live against Muse 1.1.1 on October 12, 2026; the verification note records the probes.

Muse joins Codex, Claude Code, Grok Build and Devin as a thread provider, id `muse`, shown as **Muse**. Its adapter speaks MSP, Muse's own machine protocol, over `muse serve` on stdio: one serve host process per thread (ADR-0038), identified at start, with the session loaded by `session/resume`, which serves the folded history and subscribes the connection to the view stream. `session/read` and `view/page` are in the published schema but the 1.1.1 client does not serve them, so history is read by resuming and the stream carries live work; a `view/gap` is answered by resuming again, and the adapter's one append path recognises what it already recorded. Unknown notifications and unknown item kinds are read for what they carry and never guessed at, as MSP promises additive growth.

## The gate

Muse is an Owl feature (`muse` in `src/shared/owlFeatures.ts`). On stable, main and the headless host register a stand-in host that connects nothing, lists nothing and refuses work in words, the renderer's provider lists ask the gate before showing a Muse tile or row, and the adapter's saved records (`muse-threads.json`, `muse-projects.json`, thread bindings) stay on disk untouched, so returning to Owl restores the provider whole. Sending it to stable is the one-line `sentToStable` change ADR-0072 describes.

## Sign-in and the floor

Muse keeps its own sign-in (`muse login`, or credentials it stores itself); Sotto stores no key for it, and the environment its processes get is the shared allow-list without `META_API_KEY`, so a thread always runs on the account Muse holds, never on a key that happened to be in Sotto's environment. A host tile shows `muse login` as Devin's shows its command, because the sign-in runs on the host itself. The floor is Muse 1.1.1 speaking MSP 1 (ADR-0042): an older client or another MSP version is refused at connect with the version it reported. A client with no sign-in resolves no model catalog, which is the refusal the tile offers the sign-in command for.

## Permissions

MSP splits permission into a sandbox posture sealed when the host starts and an approval mode chosen per session. The sealed mode is a ceiling: a session may select only a mode at or below it, and on the checked machine the default ceiling refused both `allowAll` and `onRequest`. So which of Sotto's modes a Muse thread may be offered is probed, not assumed: connecting starts throwaway sessions on a memory-only host and offers only the modes the client accepted, beside **Ask for approval**, which a session always starts on (`promptUnmatched`, where the client's own policy decides what asks). **Automatic** is `onRequest` and **Full access** is `allowAll`, offered only where the probe could select them. An approval the client asks about arrives as a notification and is shown as a request card with Muse's own choice labels; the user answers every one (ADR-0004), and a plain allow or deny takes the one-time form of it. Disconnecting sends no decision: the host settles its own pending approvals when it ends.

## What a Muse thread can and cannot do in this first version

Streaming replies with reasoning, tools, file changes, commands, subagents, workflows, plans and compaction as thread activity; steering; images; effort per turn from MSP's closed tier list; model and permission changes on the live session; side calls for titles and commit drafts on a memory-only host at the lowest effort under the strictest approval mode, so they can use no tools (ADR-0026); message origins through MSP's idempotency command IDs, which also finish a creation or a send whose acknowledgement was lost without repeating it.

MSP v1 has no way to attach tool servers to a session, so a Muse thread cannot be given Sotto's browser or thread tools, and cannot host Watcher: the adapter refuses a Watcher thread in plain words before its process starts, as Devin's does, and the browser surfaces say this provider does not support Sotto browser tools. Skills are not offered: MSP has no skill catalog a client may read. Token counts are shown without a price, because the catalog carries none Sotto could check. Muse is not a subscription reasoning provider: dictation cleanup and Watcher reasoning stay on the accounts ADR-0069 names, as Devin is outside them too. There is no terminal-mode entry yet.

## Hosts and phones

The headless host runs the same adapter under the same gate, read from its own release track, so a paired host offers Muse where the host machine has the client installed and signed in. The iPhone and Android clients name the provider and may open threads on it like any other; host protocol version 1 already carries provider IDs without a closed list on the desktop side, so no protocol change was needed.
