# A host's providers are connected and signed in from this computer (#460)

September 28, 2026. Branch `feat/host-provider-tiles` from `fix/host-provider-lookup` at 0e1cc2b6 (#459, whose pull request was still open at the time and has since merged), on the Windows development machine. The running-app journey is `tests/e2e/host-provider-tiles.spec.ts` against the built app (1 passed, then 5 of 5 with `--repeat-each=5`). It adds a host named forge through a scripted ssh that runs the real launch script, which starts a real headless host. That host's providers are scripted to be signed out until their fake clients (`tests/fixtures/fakeSignInCli.mjs`) sign in, and the host runs those fake clients for Sign in, over pipes, exactly as it runs the real ones. The local host is off and reduced motion is on in that profile, the host's home is a throwaway folder, and opening a page is recorded instead of opening a browser, so no real account, provider or browser is touched.

## What was proved in the running app

forge starts the way it was on September 28: Codex signed in, Claude Code and Grok Build installed and signed out, Devin not installed.

1. **The row and the tiles.** forge's row reads "SSH forge · Connected · 1 provider". **Show providers**, pressed with Enter, opens four tiles in the prototype's order and says "Hide providers": Claude Code "Not signed in" with Sign in, Codex "Connected" with Disconnect, Grok Build "Not signed in" with Sign in, Devin "Not installed", "Not on forge yet." with Check again, and the line "forge connects each provider that is signed in when its host starts. A provider you disconnect stays off." under them. Tab goes from Hide providers to the first tile's Sign in.
2. **Claude Code, code pasted back.** Sign in opens "Sign in to Claude Code on forge", with focus on **Open sign-in page**. Enter opens the page (a `https://claude.com/cai/oauth/authorize` address, checked and opened by main) and moves focus to **Code from the page**. A stale code typed and sent with Enter gets "Claude Code did not accept that code, so forge is still not signed in. Open the sign-in page again for a new code.", with focus on **Try again**. Try again starts a new sign-in; the right code signs Claude Code in, the dialog says "Claude Code is signed in and connected on forge." with focus on Done, and the tile and the row ("2 providers") follow.
3. **Grok Build, device code.** The dialog shows the code `K7PX-2QRM`, **Copy code**, **Open sign-in page** (focused) and "Waiting for you on accounts.x.ai." Escape closes it and stops the sign-in on the host; the tile still reads Not signed in. Signing in again, Enter opens `https://accounts.x.ai/oauth2/device?user_code=K7PX-2QRM`, and once the code is "entered" (the test writes the fake client's approval) the host finishes by itself and connects Grok Build.
4. **On forge alone.** Disconnect turns Codex to "Turned off" and the host records `disconnectedProviders: ["codex"]` in its own `agents.json`; Connect connects it again. Check again on Devin tries it again and the tile says "Checked again. Nothing changed on forge." Hide providers closes the tiles. No page error.
5. **Sizes and themes.** Tiles, both dialogs and the refusal were captured at 1600x1000, 1280x800 and 820x560, dark and light. Nothing scrolls sideways at any size, and the dialogs and the first tiles sit wholly inside the window at 820x560. The tiles are four across where they fit and two by two at the minimum.

## What the tests prove instead

- `tests/integration/providerSignIn.test.ts` runs the host's sign-in module over the fake clients: Codex's page and code read through its colour codes, with its 15 minutes; Grok Build's page carrying the code and no expiry, and a refusal on the page; Claude Code handed the pasted code as one line, a code without `#` or with a line break refused before the client sees it, a refused code, then the right one; a page on another host refused; Cancel, the fifteen minutes (shortened), a newer sign-in stopping an older one, and Devin refused. It checks the arguments each client is run with (`login --device-auth`, `auth login --claudeai`). Over a real headless host and socket it signs Codex and Claude Code in from one paired client, checks another paired client reads nothing of it and the shell never carries the code, and runs refresh, disconnect and connect for one provider; the desktop's phone listener does not list `provider-sign-in`.
- `tests/integration/codexAccount.test.ts`: a signed-out Codex is refused as `signed-out` with its version, a ChatGPT sign-in is named, and a Codex that cannot say connects as before.
- `tests/integration/subscriptionClaude.test.ts` and `tests/unit/main/providerSwitch.test.ts`: the problem codes and the plan ("Claude Max") from Claude Code, and the provider switch carrying `problem`, `account` and a failed client's version into the status and dropping them when turned off.
- `tests/unit/renderer/hostProviders.test.tsx`: each tile's words, the disclosure, both dialog shapes, focus, Escape cancelling on the host, the refusal and Try again. `tests/unit/shared/hostProviders.test.ts`: the pages Sotto opens, exactly. `tests/unit/host/remoteCommands.test.ts`: every host request is decided, the four sign-in requests among them.

## After review

The two-axis review found five things, all fixed on the branch, each with a test that fails without the fix:

- A start that answers after its dialog has gone (Escape while it still says Starting, or React running the effect twice) now cancels its sign-in on the host (`hostProviders.test.tsx`).
- Two starts for one provider that overlap no longer both run a client, and a host that stops during the lookup spawns nothing (`providerSignIn.test.ts`, with a lookup held open).
- The page and a printed code are read only once something follows them, so a pipe that hands the output over in pieces cannot cut Claude Code's address short (`providerSignIn.test.ts`, with the fake client's output cut in two).
- The device code is read out one character at a time from a visually hidden sibling; the code as shown is hidden from assistive technology.
- A host that fails to answer twice in a row gets "forge stopped answering while Grok Build was signing in. If its tile still says Not signed in, try again." with Try again, and the host shortens a message longer than the 600 characters the client reads.

After the review fixes and a merge of `main` (with #459 now merged), the journey ran again against the built app: `host-provider-tiles.spec.ts`, `hosts.spec.ts` and `host-provider-lookup.spec.ts`, 3 passed.

## Checked on this computer, not in the app

The sign-in shapes were read from the real clients here with throwaway homes and cancelled before any sign-in completed: Codex 0.158.0's `codex login --device-auth` and Grok Build 1.0.41's `grok login --device-auth` print their page and code into a pipe and wait; Claude Code 2.1.284's `claude auth login` reads the pasted code from standard input with `readline` (read from its bundled source rather than run, because it opens a browser on the machine it runs on); Devin 3000.10.31's `devin auth login --force-manual-token-flow` asks for its code in a full-screen terminal prompt and opened a browser here even with that flag, which was closed at once. forge's Codex (0.155.1) was read over SSH to have the same `--device-auth` sign-in.

## Not checked here

- **forge, live: pending (owner only).** After the branch is built into a host archive and forge's host is updated and restarted:
  1. In Settings → Hosts, Show providers on forge, and check the tiles match forge (Codex connected with ChatGPT, Claude Code and Grok Build not signed in, Devin not installed).
  2. Sign in to Claude Code on forge from this computer: Open sign-in page, sign in on claude.com with the Claude subscription, paste the code, Finish sign-in. The tile should read Connected.
  3. Sign Grok Build in the same way with its device code, on accounts.x.ai.
  4. Check that a real Claude Code accepts the code handed to it over a pipe; that Claude Code's attempt to open a browser on forge opens nothing there; and that nothing about the sign-in reached `~/.sotto` or the host's output.
- The Linux-only socket cases of #459 still run in CI's Linux job, not here.

## Captures

In `artifacts/host-provider-tiles/`:

- `tiles-1600x1000-light.png`, `tiles-1280x800-dark.png`, `tiles-820x560-dark.png`, `tiles-820x560-light.png`: forge's tiles as it starts.
- `sign-in-paste-1280x800-dark.png`, `sign-in-paste-820x560-light.png`: Claude Code's dialog after Open sign-in page, waiting for the code.
- `sign-in-refused-1280x800-light.png`, `sign-in-refused-820x560-dark.png`: a refused code, with Try again.
- `sign-in-device-code-1600x1000-dark.png`, `sign-in-device-code-820x560-light.png`: Grok Build's device code.
- `tiles-after-1280x800-dark.png`: three providers connected, and Devin after Check again.
- `host-providers.json`: each provider's connection on forge at the end.

## Design gate

The tiles and the dialog are new, under an existing row, and follow the owner's pick (layout B). `npm run design:verify` covers no Hosts page with a connected host, so no baseline covers this surface and none was regenerated.
