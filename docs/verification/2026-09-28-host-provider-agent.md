# An agent installs, updates or fixes a host's provider from this computer (#461)

September 28, 2026. Branch `feat/host-provider-agent` from `feat/host-provider-tiles` at 4474929e (#460), on the Windows development machine. That branch merged into `main` as #467 the same evening, and `main` was merged into this branch before the gates below were run again. The running-app journey is `tests/e2e/host-provider-agent.spec.ts` against the built app. It adds a host named forge through a scripted ssh that runs the real launch script, which starts a real headless host whose providers are scripted: Codex signed in, Claude Code and Grok Build signed out, and Devin not installed until the file `devin.installed` appears in the fixture's folder, which stands for an agent's install putting Devin where the host looks. The local host runs, with the end-to-end providers, because the job's thread is a thread on this computer; its model is "Claude Test". The host's home is a throwaway folder and reduced motion is on, so no real account, provider or machine is touched. The scripted provider calls no tools, so the journey calls the job's tool the way a provider would, through the end-to-end bridge, which reaches the same `sotto_host_setup` server as the thread's own endpoint.

## What was proved in the running app

1. **The button beside Check again.** Devin's tile reads "Not installed", "Not on forge yet.", with **Have my agent install it** (its accessible name "Have my agent install Devin on forge") and **Check again**.
2. **The dialog, from the keyboard.** Enter on the button opens "Install Devin on forge": "An agent installs Devin on forge from this computer, in a thread you can watch. It reaches forge through this computer's SSH, and its tool works only on forge. It stops once forge's host finds Devin; you then sign in.", the **Model** picker on Claude Test (the model with the most threads), the line saying the thread's provider receives the brief and what the agent's commands print on forge, and "The thread Install Devin on forge goes in the Host setup project." Focus starts on **Start install**. Escape closes it, starts nothing and puts focus back on the button.
3. **Start install and the working tile.** Enter, Enter starts it. The dialog closes onto the tile, which reads "Agent is installing it" and "In the thread Install Devin on forge on this computer.", with focus on **Show thread** and **Stop** beside it. The job is `running`.
4. **The tool, fixed to forge's Devin.** `provider_status` answers for forge and Devin, `install`, not found, `not-installed`; `provider_check` (Check again) still does not find it; `host_add`, the host setup's tool, is refused to this thread.
5. **Show thread** opens the Threads page on the thread "Install Devin on forge".
6. **Stop.** Back in Settings → Hosts, Stop stops the thread. The tile reads "Not installed" again with "Stopped. Anything the agent installed on forge stays there, and the thread Install Devin on forge stays in your Threads list.", focus lands on Have my agent install it, and the tool is refused from then on.
7. **It stops at found.** A second job starts; the fixture's install appears; `provider_check` answers found. The job is `found`, the tile turns to "Not signed in" with Devin's sign-in command, and says "forge's host found it. Claude Test worked in the thread Install Devin on forge." Nothing signed Devin in. No page error.
8. **Sizes, themes and contrast.** The dialog, the working tile and the found tile were captured at 1600x1000, 1280x800 and 820x560, dark and light. Nothing scrolls sideways, the dialog and the tile sit wholly inside the window at every size, and every piece of the dialog's and the tiles' text measured at least 4.5:1 on its surface.

## What the tests prove instead

- `tests/integration/hostProviderJob.test.ts` drives the scoped tool over a real headless host and socket with the fake providers: the brief (the host, `ssh zach@forge`, Devin, "did not find", where the host looks, Cognition's installer, no key or credential), `provider_status`, Check again before the install, and the job ending when the host reports Devin found, before any sign-in. It proves the tool reached forge's Devin alone: an argument naming another provider and the host setup's own tools are refused, every refresh was forge's Devin, Codex stays connected and Claude Code and Grok Build stay signed out, and the token is revoked at the end.
- `tests/unit/main/hostProviderJob.test.ts`: the brief for each case (too old with the version found and needed, the update channel rule, Claude Code's floor that is not a version, Codex's native binary), one job at a time and not beside a host setup, a provider the host can already use refused, the job found by a host update without the tool, Stop, an archived thread stopping it, a thread that did not start, and the server listing each thread only its own job's tools and refusing arguments.
- `tests/unit/renderer/hostProviderAgent.test.tsx`: the three buttons and their tiles' words, the dialog's words, model and Start, Escape starting nothing, a refusal kept in the dialog, the dialog when no model can run it, and the working, stopped and found tiles, including a job on another host leaving the tile alone and focus after Stop.
- `tests/unit/main/hostSetup.test.ts` and `tests/integration/hostSetupTools.test.ts` still pass: the host setup thread lists its three tools, and the clients are given one server for both jobs.

## After review

The two-axis review made five findings, two of them the same mistake in the tile and in main. Each was fixed in its own commit with a test:

- A provider in error with no problem code (an adapter that threw a plain error, such as Codex not confirming the connection) read as "Can't be started" but its tile had no action, and main refused its job as "the host can already use" it. One shared helper now makes it a fix, in the tile and in main; its tile offers Have my agent fix it and Check again.
- Stop pressed while a job or a host setup was starting, before its brief was sent, left the thread working through the brief. The start now interrupts the thread once it has taken the brief.
- `provider_check` answered found to a thread whose job was stopped while the host was looking. It now says the job was stopped.
- A tile moved focus to its first button on any change of state while focus sat on the page. It now moves focus only when its own pressed control was taken away.

## Too old

Sotto already had floors, so the too-old case is built rather than left waiting: Grok Build 1.0.5 and Devin 3000.10.31, the versions their adapters were checked against (ADR-0042), and Claude Code's set of flags. Each is now written next to its adapter with its reason, and a client refused as too old carries its floor to the tile and the brief (`requiredVersion`): "0.9.12 on forge. Sotto needs 1.0.5 or later." Claude Code's floor has no version number, so its tile says "Sotto needs a newer version." Codex has no floor, and none was added.

## Checked on this computer, not in the app

Each provider's official install method was read from its maker's pages on September 28: `https://code.claude.com/docs/en/setup` (Anthropic's `install.sh`, which puts `claude` in `~/.local/bin`, and npm's `@anthropic-ai/claude-code`), `https://github.com/openai/codex` (npm's `@openai/codex`, OpenAI's `install.sh`, and the release archive), xAI's `@xai-official/grok` on npm and its `install.sh`, and `https://docs.devin.ai/cli` (Cognition's `install.sh`). forge's layout was read over SSH without changing anything: its clients come from mise (`installs/claude`, `installs/codex`, `installs/node`, `installs/npm-xai-official-grok`), `~/.local/bin` holds mise wrappers, and Devin is not installed.

## Not checked here

- **forge, live: pending (owner only).** After this branch is built into a host archive and forge's host is updated and restarted:
  1. In Settings → Hosts, Show providers on forge. Devin's tile should read "Not installed" with Have my agent install it.
  2. Press it, pick a model and Start install. Answer each command the agent asks to run on forge in the thread "Install Devin on forge". It should install Devin with Cognition's installer somewhere the host looks, call `provider_check`, and stop once forge's host finds Devin.
  3. The tile should then read "Not signed in" with the command to run; sign Devin in on forge with it. Check that nothing in the thread or the host's output carries a key or a sign-in code.
- A real Claude Code, Codex or Grok Build calling `provider_status` and `provider_check` over its own MCP client; the adapters' configuration for `sotto_host_setup` is unchanged and covered by `hostSetupTools.test.ts`.

## Captures

In `artifacts/host-provider-agent/`:

- `agent-dialog-1280x800-dark.png`, `agent-dialog-820x560-light.png`: "Install Devin on forge", with the Model picker.
- `agent-working-1600x1000-light.png`, `agent-working-820x560-dark.png`: Devin's tile while the agent works, with Show thread and Stop.
- `agent-found-1280x800-dark.png`, `agent-found-820x560-light.png`: Devin's tile once the host found it, waiting for the user to sign in.
- `provider-job.json`: the job as Settings → Hosts last read it.

## Design gate

The dialog and the working tile are an affordance on the tiles, drawn from the owner's pick (layout B, round 2 of `prototype/host-providers`). `npm run design:verify` has no baseline for a Hosts page with a connected host, so none covers this surface and none was regenerated.
