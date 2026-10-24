# Cursor as a thread provider: what was checked

October 23, 2026. [ADR-0128](../adr/0128-cursor-is-a-thread-provider.md) and its amendment "Watcher, hosts and phones, as built". Every live check ran on the Windows laptop against Cursor's CLI **2026.10.22-27dcf5f**, the version installed and signed in there and Sotto's floor, on **GPT-5.4 Nano** at low effort, the cheapest model checked. Every live Cursor process ran with `CURSOR_CONFIG_DIR` pointed at a scratch folder, never the user's own `~/.cursor`, and no live run signed in or out. The research note's [Appendix B](../research/cursor-cli.md#appendix-b-live-checks-against-20261022-27dcf5f-2026-10-23) has the wire facts checked before the adapter was built.

This note has no screenshots: the Settings tile, model menu and request cards were checked by the UI work in its own commit.

## Live, against Cursor's own CLI

**Ordinary threads.** `SOTTO_CURSOR_LIVE=1 npx vitest run tests/integration/cursorLive.test.ts`, run once after the adapter was built and again after Watcher was wired, passed both times. In a scratch Sotto Cursor folder, a thread on GPT-5.4 Nano replied, asked before `git status --short` under Ask for approval with exactly **Allow once** and **Reject**, went on after the reject, came back after a restart with the same message IDs and texts from Cursor's replay, and wrote a branch name as short text in `ask` mode. The user's own `cli-config.json` was the same byte for byte before and after.

**Two wire facts for Watcher**, with a throwaway ACP probe outside the repository (`%TEMP%\cursor-watcher-probe`), its own scratch Cursor folder and a loopback MCP server of its own answering one tool, `list_threads`:

- With `permissions.allow: ["Mcp(sotto_threads:*)"]` in the folder's `cli-config.json` and Cursor's `allowlist` mode, an HTTP server named `sotto_threads` given in `session/new` was initialized, listed and called (`tools/call list_threads`) with no `session/request_permission`, and every request carried the bearer token given in its headers.
- A prompt of one text part, Watcher-shaped instructions, the user's words and a request note's line (467 characters), came back from `session/load` in a second process as one `user_message_chunk` equal to what was sent, character for character. Cursor did not echo it during the live turn.

**A Watcher-shaped turn through Sotto's adapter.** `SOTTO_CURSOR_LIVE=1 npx vitest run tests/integration/watcherOnCursorLive.test.ts` passed (one turn, about 75 seconds). A thread with Watcher's launch profile, its `sotto_threads` server being the test's loopback server, was sent "Call the list_threads tool once, then reply with only the number of threads it listed." with a request note. The tool was called once with the thread's token, no request waited on the user, the reply said 3, and the thread showed the message as typed. After the adapter was stopped and started again over the same Sotto folders, the message Cursor replayed, with Watcher's instructions and the note, was shown as typed under the same message ID. The profile was never revoked, and the user's own `cli-config.json` was unchanged. No Watcher service ran: the real one is driven over the fake client below.

## Over the fake Cursor client

- `tests/integration/cursorAdapter.test.ts`: the adapter contract and Cursor's own cases, 52 passing and 6 skipped. The six are the contract's background-work, live-settings and settings-confirmation cases, which Grok Build, Devin and Muse skip too, for reasons that hold on Cursor. New cases cover Watcher on Cursor (its servers and never the browser, the folder rule, instructions and note on the wire and the words shown as typed live and after a restart, a wake-up's news, permissions as allow once or reject, a Cursor that takes no tool servers, a profile main cannot verify, a process started without Watcher's tools, no short text) and a process slow to start.
- `tests/integration/watcherOnCursor.test.ts`: Sotto's runtime with Watcher on and Cursor's Owl gate open. Watcher opened on a Cursor model, the user's first message made its session with `sotto_threads` and without the browser, and the fake client, calling Watcher's real server over HTTP as Cursor's model would, listed threads and projects, started a worker on a fake Codex, which received its first prompt once, and read it back. An ordinary Cursor thread is given no `sotto_threads`.
- `tests/integration/watcherOwnTools.test.ts` and `watcherOrdinaryThreads.test.ts` now run on Cursor too: skills with Watcher's profile, every permission mode through early start, a client update and a cold resume, the phone's mode recheck, and ordinary threads with a corrupt, invalid or unreadable Watcher identity.
- `tests/integration/watcherPairedHosts.test.ts`: a Watcher on Cursor reads and directs a paired host only when it lists `watcher-cursor`, and says to update one that does not.
- Hosts: `headlessHost.test.ts` and `socketHostContract.test.ts` pass the host service contract for Cursor (20 cases); `socketProviderPeers.test.ts` sends an older phone and an older desktop nothing of Cursor from any shell field, event, detail, Watcher answer, read or projection, and refuses their reads and directions of Cursor threads; `providerSignIn.test.ts` runs a host's Cursor sign-in in its page shape; `socketHostFeatures.test.ts` lists `watcher-cursor`.

## In the built app

`tests/e2e/cursor-provider.spec.ts` runs the built Owl app with Cursor's real adapter over the fake Cursor client (`SOTTO_E2E_CURSOR_ROOT`), in a profile of its own, dark with reduced motion on, and passed on October 24, 2026 after main was merged in. Its captures are in [`artifacts/cursor-provider/`](../../artifacts/cursor-provider/):

- `signed-out-1600-dark.png`: Cursor switched on and connected while signed out. The tile says Sotto uses Cursor's own sign-in and offers **Sign in**, with no alert repeating it.
- `signing-in-1280-dark.png`: after **Sign in** (variant A). Main wrote the `https://cursor.com/` page down instead of opening a browser, Cursor's `login` ran with `NO_OPEN_BROWSER=1` and Sotto's own Cursor folder under the profile, and the tile says to finish on cursor.com, with **Open the page again** and **Cancel**. Writing the fixture's `login-done` connected Cursor by itself.
- `connected-820-light.png`: connected, at the minimum window in light. The panel was also captured at 1600x1000 and 1280x800 in dark; nothing in it was cut off at any size.
- `makers-1280-dark.png` and `anthropic-820-light.png`: the model menu opens on Cursor's model makers (Cursor, Anthropic, OpenAI) with the foot saying every model runs through Cursor on the user's plan; Anthropic's models show under **Makers**; Escape steps back to the maker's row and then to the chip. The chip reads Anthropic / Claude Fixture with "Claude Fixture from Anthropic, in Cursor" as its title and Cursor's mark.
- `permissions-1280-dark.png`: Provider default, then exactly Cursor's three modes with Cursor's own descriptions, and no Allow edits.
- `stable-providers.png`: the same profile with Cursor's Owl feature off. No Cursor tile, and `cursor-projects.json` kept.
- `contrast.json`: every text measured is at least 4.5:1, the lowest the menu foot in light at 6.1:1.

The first run found two faults, both fixed in this change: while a sign-in waited, the tile still showed the Connect press's error telling the user to sign in and connect again, and the tile's sign-in found Cursor's program by itself rather than the one the adapter runs, so a fixture's sign-in would have started the real `agent login`.

## The flaky adapter tests

Three adapter tests had each failed once in a full run. Twenty-four runs of `cursorAdapter.test.ts` (eight sequential, eight at once, and six pinned to two cores beside a busy loop, as [docs/ci.md](../ci.md) describes) all passed. With the machine at 98% CPU from other work, two failures reproduced: the contract's uncertain-acknowledgement case, whose thread's create had come back uncertain, and a Watcher case whose create was never confirmed. The cause: a freshly started process's first answer, to `initialize`, was given the acknowledgement deadline, which the fixture sets to two seconds and a loaded machine's process start can pass. It now has a start deadline of its own (30 seconds). A test now holds a process's start past the fixture's two-second acknowledgement deadline. It fails with the old deadline and passes with the new one. After the fix, six further runs on that loaded machine, and the 20 Cursor host-contract cases, passed.

## Not checked

- **Neither phone was compiled.** The laptop has no Mac, JDK, Gradle cache or Android SDK. CI's macOS job builds the iPhone app and runs SottoCore's XCTest suite, which this change extends. The Android JUnit tests were extended the same way and have not been run. `tests/unit/shared/phoneProviderMarks.test.ts` checks both phones' cube against the desktop's path.
- No paired host over SSH was used: the host checks ran in-process and over a local socket, with the fake client.
- The real Watcher service was not driven live on Cursor; the live Watcher-shaped turn used the adapter with a stand-in tool server.
