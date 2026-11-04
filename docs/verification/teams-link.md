# The first slice of Teams, in the running app

November 3, 2026, on the built app from this pull request, on Owl's feature answers. ADR-0186 and ADR-0187 say what was meant to hold.

## Two real instances on forge

Two separate Sotto instances on forge, each with its own data folder, called Zach and Drake here. Each ran real Tailscale Serve, and each talked to the other over real tailnet HTTPS at `https://forge.tail5728ca.ts.net:8445` and `:8446`, with a real Watcher and real side calls on Claude Code's Haiku 5.5. A real Linux session's keyring was not available, so a small entry file turned on Electron's plain text credential store for this run only. Nothing in the app changed for it.

- [x] **Make a code and Link.** One code linked both directions and each showed the other, lasting until December 4. Tailscale listed 8445 and 8446 as tailnet only.
- [x] **The closed list over real HTTPS.** A GET gave 404, `{"command":"start-thread"}` gave 400 with `not-on-the-list`, and an ask with no token gave `not-linked`.
- [x] **"Give me a list of what Drake is working on for Sotto."** Zach's Watcher called `ask_teammate` and ended its turn in 7.6 seconds. The answer, from Drake's provider and with no tools, showed in Zach's conversation as a teammate's message, about 9 seconds after the Send (`real-zach-conversation.png`).
- [x] **A teammate's message starts no turn.** Drake's Watcher had 0 messages before and after, and its conversation was still empty. Drake's Teams tab listed each ask and what it answered, and counted 2 of 20 (`real-drake-teams-tab.png`).
- [x] **Watcher reads it with the next message.** Asked "What did that say?", Zach's Watcher gave Drake's answer in a sentence through `read_teammate_messages`.
- [x] **Coordinate merge priority.** The same message went on to ask about merge priority. Zach's Watcher sent its words, Drake's answered from its list, and nothing merged.
- [x] **Quitting** took both Serve settings off.

What this caught, and the pull request fixed: Haiku went to `gh pr list --author` for "what Drake is working on" instead of asking, because the user's global notes point there, so the prompt and the tool now say to ask first. Answers said "your list" from the wrong side, so the writer is told who "you" is.

## The built app on seeded links

`tests/e2e/teams.spec.ts`, in dark and light, with reduced motion, at 1600x1000, 1280x800 and 820x560:

- Stable shows no Teams tab and no row, and main has no handler for it.
- Left and Right move between the tabs and focus stays on the tab, and the page's own controls come next in the Tab order.
- Nothing overflows at the minimum, and the page clears the scene's owls.
- A pasted code naming another host says so and links nothing.
- Removing a link asks first and leaves the forms.
- Settings > Hosts & phones says when a link was last used.

The screenshots here are the real run's, and the journey writes its own under `artifacts/e2e-runs/teams-link/` when it runs.

## Not proved

- **The laptop and forge as two computers.** This needs a Windows build with the feature, which the next Owl after this merges will be. Nothing here ran on Windows or on a Mac.
- **Two tailnets.** Drake's computer is not on Zach's tailnet, and only Tailscale's documentation says that device sharing carries Serve between them (`tailscale.com/kb/1084/sharing`, `kb/1312/serve`). A shared machine cannot start connections unless the sharing goes both ways, and the guide says to share each way. The first real link between Zach and Drake is the proof.
- **A provider other than Claude Code** answering on two computers. Codex and Grok Build's side calls are ADR-0026's, tested in their own suites; Devin cannot be Watcher.
