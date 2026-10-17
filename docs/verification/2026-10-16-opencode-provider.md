# OpenCode provider: what was checked

October 16, 2026. [ADR-0087](../adr/0087-opencode-is-a-thread-provider.md), issue #1103. The adapter's own tests, the review fixes and the running desktop journey are recorded below.

## The adapter, through its contract

`tests/fixtures/fakeOpenCodeServer.mjs` is a scripted `opencode serve` built from the routes and events OpenCode 2.0.31 answered in a scratch probe. `tests/integration/opencodeAdapter.test.ts` runs the shared adapter contract against it, with the fixture's documented skips (no background work, no live-settings refusal to recover from, no client update until #1104), and focused tests for the password, Sotto's own OpenCode folder, version refusals, rule sets per mode, permissions answered once or rejected and never `always`, forms drawn or cancelled, images, steering, a server that dies mid-turn, the first-server lock and the tree kill.

The review of #1103 found nine things. Each test below failed before its fix and passes with it.

- **A server that exits by itself leaves no tool behind.** A detached grandchild of the fake server kept running after the server exited on its own, because stopping an exited server did nothing. Stopping now ends what it left: on Windows, the processes whose recorded parent chain leads to the dead server and that are newer than it (never a process that took its PID afterwards, and never Sotto); elsewhere, its process group, which outlives its leader.
- **A server whose event stream fails before its first event is stopped.** The fake answers the stream with an error; the server is gone once `closed()` resolves.
- **The connect check's server stops on disconnect.** With the catalog answer held, `disconnect(); await closed()` waits for that server to stop.
- **Restored history puts each turn's activity under its own prompt,** even when Sotto's store already holds every message of the thread.
- **The files a step changed are a file change,** live and restored, from `session.step.ended`'s `files` and the history snapshot's, without repeating a file an edit tool already reported.
- **OpenCode 3 is refused in words,** as 1.x and 2.0.30 are; 2.0.31 is accepted.
- **Hosts do not offer OpenCode** until #1107: no tile, no host connect, sign-in or agent job, and no install brief.
- The two tests that slept now wait on the fake's own record of the provider session, and on streamed words in the live suite. Bookkeeping nothing read was removed.

## Running desktop

Built with `npm run build`, then driven with `npx playwright test tests/e2e/opencode-provider.spec.ts` on Windows. The journey uses the real renderer, preload, coordinator and OpenCode adapter over the scripted server, in an owned fresh profile, with Owl's OpenCode feature on. It is not OpenCode itself; the live suite below is.

- Settings > Providers > OpenCode connects, shows 2.0.31, says its folder is Sotto's own and that no model source is signed in yet, and lists the fixture's OpenCode Zen model. Light and dark at 1600x1000, 1280x800 and 820x560 with reduced motion, no horizontal overflow; the account line measures at least 6.71:1, Allow once at least 15.74:1 (`contrast.json`). [Settings, 1600 dark](../../artifacts/opencode-provider/settings-1600-dark.png), [Settings, 820 light](../../artifacts/opencode-provider/settings-820-light.png).
- A new thread on that model: a prompt, a command, the file its step changed, a permission card answered with Allow once and another with Reject, a question card from a form, a streamed reply, a second turn whose write tool reports its own file once, and Stop on a running turn, which ends it as interrupted. [Permission, 1600 dark](../../artifacts/opencode-provider/permission-1600-dark.png), [permission, 820 light](../../artifacts/opencode-provider/permission-820-light.png), [question](../../artifacts/opencode-provider/question-1280-dark.png), [both turns with their activity](../../artifacts/opencode-provider/thread-activity-1280-dark.png).
- Restarting on the same profile reads the history back from OpenCode, with each turn's command and file changes under its own prompt, matching what was shown live (`journey.json`). [First turn restored](../../artifacts/opencode-provider/restored-first-turn-1280-dark.png), [the stopped turn restored](../../artifacts/opencode-provider/restored-thread-1280-dark.png).
- Stable (Owl off) starts no OpenCode process and shows no OpenCode provider, model, project or thread; its saved threads and projects are byte for byte the same afterwards. With Owl back, the thread and its history return under the same ID. [Stable providers](../../artifacts/opencode-provider/stable-providers.png).

What the captures also show, outside this change: the fake's replies carry its fixed clock, so they read 5:00 am beside prompts sent at 8:30 pm; a file change shows the absolute path, as every provider's does; Installed client says Sotto could not read the published version, because updating OpenCode is #1104; and at 820x560 the Settings footer sits over the last line until the page scrolls, as it does on every provider.

The Muse, providers-this-computer, host-provider-tiles and model-menu-wheel journeys were run again on the same build.

## OpenCode itself

`tests/integration/opencodeLive.test.ts` under `SOTTO_OPENCODE_LIVE=1` against `@opencode/cli` 2.0.31 installed in a scratch folder, on a scratch Sotto folder under the system temp folder, OpenCode Zen's free models only: connect, a reply, a write asked and rejected, a restart that reads the same messages back, and Stop on a streaming answer. No OpenCode data, config or app of the user's was read or touched.
