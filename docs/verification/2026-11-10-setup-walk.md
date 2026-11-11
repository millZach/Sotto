# First-run setup's walk, in the running app

November 10, 2026, on forge (Linux), from `feat/setup-walk`. The built app (`npm run build`, `out/main/index.js`) under Xvfb. Forge is Linux, so the walk has twelve stops; Windows and macOS have eleven, without Omarchy's.

## With the real clients, in an empty home folder

The app was started outside test mode with a private, empty home folder, so the real clients on forge were found and none was signed in. Every stop was visited with the note's way forward, at 1080x720.

- A new profile opened on the real Threads page with the first note over it.
- Arriving at the agents stop connected every installed agent: Claude Code and Grok Build read Not signed in with Sign in, Devin and OpenCode read Too old to use with Install guide. The note said none was ready, and Skip for now passed over the project and the thread to dictation.
- At every stop the note was inside the window and off the control it lit.
- The last note listed what was left and where it lives.

`artifacts/setup-walk/agents-real-clients-1080x720.png` is the agents stop from this run.

## In the test build, to a first thread and on

`tests/e2e/setup-walk.spec.ts`, with an agent connected and a throwaway home folder:

1. The first note: Light and Dark repainted the window at once. A click on the sidebar's Settings link, under the dim, did nothing.
2. Agents, on Settings › Providers, read "An agent is ready." and Continue.
3. Add project, the sidebar's own, opened its folder browser with nothing of the walk over it. Choosing a folder added the project and opened a thread in it.
4. The note moved to the thread's composer: "This is a thread", "Your first thread is open. The rest is optional.", Continue to dictation and Finish here. Twelve presses of Tab stayed in the note and the composer.
5. Settings' microphone test, pressed from under the note, heard the test build's voice; the note said so, and the test was closed once the walk moved on.
6. Speech model, shortcut (on the Dictate page), Tailscale, Add host and Phones were each lit in turn. Let phones connect, pressed in the lit card, stayed off without Tailscale and said why.
7. The last note left out what was done. Done saved `onboardingComplete` true and `microphoneSkipped` false, and left the Threads page.
8. Set up Sotto, in Help, started the walk again, and Escape ended it with nothing saved.

`tests/e2e/first-run-setup-fit.spec.ts` visited every stop at 1080x720, 820x560, 1280x800 and 1600x1000, dark and light: each note was inside the window, off the lit control and not scrolling. At 820x560 the sidebar is a rail, and the project and thread stops lit its Expand sidebar.

- `artifacts/setup-walk/welcome-1080x720.png`, `first-thread-1080x720.png`, `end-1080x720.png`: the first note, the first thread, the last note.
- `artifacts/setup-walk/project-rail-820x560.png`, `iphone-820x560.png`: the smallest window.
- `artifacts/setup-walk/help-set-up-sotto-1080x720.png`: Set up Sotto in Help.

## Not checked here

- Windows and macOS. The specs above run there in CI; nobody has walked setup by hand on either.
- A sign-in carried through from the agents stop to Connected against a real account.
- The shortcut stop's "That worked.", which needs a dictation; forge's test build cannot press the global shortcut. The unit test covers it.
- A real download at the speech model stop.
- The design capture baselines. The captures of the nine card steps and the tour are replaced in the matrix by captures of the walk's stops, but `artifacts/design/app-review/` still holds the old images: retaking them needs `npm run design:capture` on Windows.
