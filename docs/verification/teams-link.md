# The first slice of Teams, in the running app

November 3, 2026, on the built app from this pull request, on Owl's feature answers. ADR-0186 and ADR-0187 say what was meant to hold.

## Two real instances on forge

Two separate Sotto instances on forge, each with its own data folder, called Zach and Drake here. Each ran real Tailscale Serve, and each talked to the other over real tailnet HTTPS at `https://forge.tail5728ca.ts.net:8445` and `:8446`, with a real Watcher and real side calls on Claude Code's Haiku 5.5. The run's shell had no session bus, so it found no keyring, and a small entry file turned on Electron's plain text credential store for this run only. Nothing in the app changed for it. The laptop and forge run below used forge's real keyring.

- [x] **Make a code and Link.** One code linked both directions and each showed the other, lasting until December 4. Tailscale listed 8445 and 8446 as tailnet only.
- [x] **The closed list over real HTTPS.** A GET gave 404, `{"command":"start-thread"}` gave 400 with `not-on-the-list`, and an ask with no token gave `not-linked`.
- [x] **"Give me a list of what Drake is working on for Sotto."** Zach's Watcher called `ask_teammate` and ended its turn, in 6 to 14 seconds across the runs. The answer, from Drake's provider and with no tools, showed in Zach's conversation as a teammate's message, within 15 seconds of the Send (`real-zach-conversation.png`).
- [x] **A teammate's message starts no turn.** Drake's conversation was still empty afterwards (`real-drake-teams-tab.png` is the tab; the empty conversation was read in the same run). This note used to also say Drake's Watcher had 0 messages before and after. That count read Sotto's thread list, and the run below found that list holds no messages even for a Watcher with a conversation, so it may have measured nothing and is withdrawn. The run below has the stronger check. Drake's Teams tab listed each ask and what it answered, and counted 2 of 20 (`real-drake-teams-tab.png`).
- [x] **Watcher reads it with the next message.** Asked "What did that say? One sentence, and look nothing up.", Zach's Watcher gave Drake's answer in a sentence, in one step, through `read_teammate_messages`.
- [x] **Coordinate merge priority.** Zach's Watcher sent "I have nothing open.", Drake's computer answered from its list, and nothing merged.
- [x] **A card still stops it.** In one run Zach's Watcher wanted `gh pr list --author @me` before asking about merge priority, and at Ask for approval that waited on an ordinary permission card. Nothing went until then. Its native tools are the user's, as ADR-0187 says.
- [x] **Quitting** took both Serve settings off.

These were repeated on the final code after the two-axis review. What the first runs caught, and the pull request fixed: Haiku went to `gh pr list --author` for "what Drake is working on" instead of asking, because the user's global notes point there, so the prompt and the tool now say to ask first. Answers said "your list" from the wrong side, so the writer is told who "you" is. Haiku still does it sometimes ("the only thread in your Sotto list"), so that is guidance and not a guarantee.

## The built app on seeded links

`tests/e2e/teams.spec.ts`, in dark and light, with reduced motion, at 1600x1000, 1280x800 and 820x560:

- Stable shows no Teams tab and no row, and main has no handler for it.
- Left and Right move between the tabs and focus stays on the tab.
- The question before removing a link takes focus, and Escape closes it and gives focus back.
- Nothing overflows at the minimum, and the page clears the scene's owls.
- A pasted code naming another host says so and links nothing.
- Removing a link asks first and leaves the forms.
- Settings > Hosts & phones says when a link was last used.

The screenshots here are the real run's, and the journey writes its own under `artifacts/e2e-runs/teams-link/` when it runs.

## The laptop and forge as two computers

November 4, 2026, on the published Owl 0.1.43-owl.20261104.1 (checksums verified), Windows on the laptop and Linux on forge, over the one real tailnet, with real Tailscale Serve and real Watchers and side calls on Claude Code's Haiku 5.5.

Neither machine ran that Owl as its installed app: the laptop's was 0.1.43-owl.20261103.1, and forge had only a paired host. Updating the laptop would have restarted every thread on it, so each ran the published build from a scratch folder with its own data folder, beside what was installed. On the laptop it ran in the desktop session, so the credential store was the real one. Forge used its real keyring. The test driver pressed the real Link, Make a code and Remove link controls through the debugging port rather than by hand, and sent Watcher's messages through the app's own bridge rather than the composer. Both scratch folders are gone.

- [x] **Make a code and Link.** One code, made on forge and pasted on the laptop, linked both directions until December 4. Remove link on each side left no link, and a new code linked them again.
- [x] **The closed list, both directions.** A GET gave 404 and `{"command":"start-thread"}` gave 400 with `not-on-the-list`, from each computer to the other. An ask with no token gave `not-linked`, forge to laptop only.
- [x] **Asks, both directions.** Laptop to forge: "Give me a list of what Drake is working on for Sotto." answered in 9 seconds, and merge priority in 9 seconds. Forge to laptop: "Ask my teammate Zach what they are working on for Sotto." answered in 9 seconds, with the side call running through Claude Code on Windows (`windows-conversation-answer.png`).
- [x] **A teammate's message starts no turn.** The answering Watcher's Claude Code session log was the same size before and after each ask where it was measured: forge's did not exist yet for the first ask and was 370,454 bytes before and after the merge priority ask, and the laptop's was 507,633 bytes before and after forge's ask. No thread started running on the answering side.
- [x] **The credential store on Windows.** `credentials.json` holds the token encrypted under its `team-link:` slot (it starts with Electron's encrypted prefix), and `team-links.json` has no token field.
- [x] **Restart.** A hard kill and a start kept the link and the Serve port, and asks worked both directions afterwards. The kill was of a copy that a bad quit command from the test driver had hung, not an app hang. A clean quit and start after that also kept the link.
- [x] **Tailscale coming back.** With Tailscale reading as stopped, the link showed `tailscale-off` and stayed so after 35 seconds. Forge's ask said "Zach's computer did not answer. Nothing is waiting to send. Ask again when it is on." The listener came back 30 seconds after Tailscale read as running again, with no press, and the next ask was answered. See "Not proved" for what stood in for Tailscale.
- [x] **Quit.** A clean quit took only the Teams setting off Serve. The laptop's paths and TCP ports, and forge's, matched what they were before the run, including the laptop's port 10000 and its other paths.
- [x] **The look on Windows.** The Teams tab in dark and light at 1600x1000, 1280x800 and 820x562 (the window came up 2 pixels taller than asked), with nothing wider than the window (`windows-teams-dark-1280x800.png`, `windows-teams-light-820x560.png`).

What this found, filed and not fixed here:

- **#2150.** Watcher is not told who is linked. A teammate named "Forge" was looked for among the machines and reported as not linked, and "Zach" on a computer whose global notes say the user is Zach was answered from Watcher's own list. Neither name was asked over the link. "Drake" and "my teammate Zach" worked first time.
- **#2151.** The Teams tab does not read `problem`, so a link that cannot listen still says "Lasts until December 4." with no warning (`windows-tailscale-off.png`). Only the teammate sees a failure.

Haiku called `ask_teammate` with the wrong shape once and retried, and it still sometimes says "you" from the wrong side.

## Two desks and the merge order

November 4, 2026, built from the pull request for [ADR-0189](../adr/0189-two-desks-read-a-teammates-summary-on-a-press.md). The laptop was not used.

**Two real instances on forge**, each with its own data folder and home, on real Tailscale Serve HTTPS and forge's real keyring, with the real buttons pressed through the debugging port:

- [x] **Opening sends nothing.** Open two desks, left open for 16 seconds through a refresh of the user's own desk, gave Drake's computer no read (`real-desks-read.png` is after the press).
- [x] **A press reads once, with no model.** Get Drake's desk came back in about a second with Drake's two threads. There was no teammate's message on either computer, and no Claude Code session under either Watcher.
- [x] **The closed list.** `read-desk` with no token gave `not-linked`, and with an extra field gave 400 `not-on-the-list`.
- [x] **The owner sees each read.** Drake's Teams tab said "Zach read your desk." for each one (`real-drake-lists-read.png`).
- [x] **Left out stays out.** With Sotto left out on Drake's side, the next read came back with no threads, and Drake's own desk matched.

These two instances held no open pull requests, so the real run did not show an order with real checks. `tests/unit/shared/teamMergeOrder.test.ts` and `tests/integration/teamsWatcher.test.ts` hold the order and where checks come from.

Quitting both at the same moment took 8446 off Serve and left 8445, pointing at a dead port. Each quit runs `tailscale serve off` once and logs a failure, and only two instances on one computer can collide like that. A leftover like this is what the next start already takes back as its own, as the laptop run above showed. It was removed by hand here.

**`tests/e2e/teams.spec.ts`**, in dark and light, with reduced motion, at 1600x1000, 1280x800 and 820x560:

- [x] Opening shows your desk, nothing of Drake's, and the order saying it needs Drake's desk (`desks-not-read-dark-1280x800.png`).
- [x] A computer that does not answer says so, and that nothing waits to send.
- [x] A desk that was read shows its threads, how many did not fit, its time and the order, which holds no button (`desks-read-dark-1280x800.png`, `desks-read-light-820x560.png`).
- [x] A teammate's title shows as text, markup and all.
- [x] A read of this computer's desk shows under **Latest**, and every kept read is in the fold below it.
- [x] Nothing overflows at the minimum.
- [x] Focus lands on Back, Escape closes the desks, and focus returns to Open two desks. The journey found that disabling Get while it read dropped focus and Escape with it, so it now stays focusable and ignores a second press.

## Not proved

- **A real `tailscale down` on the laptop.** A small stand-in for the `tailscale` command, seen only by the scratch copy, reported Stopped and refused Serve, and passed everything else to the real command. A real one would cut the laptop off its paired host and every tailnet page, and SSH from forge over the local network is refused, so a failed `tailscale up` could not have been put right from forge. It needs someone at the laptop. The real output of a stopped Tailscale on Windows, and anything Serve does while it is stopped, were not seen.
- **Reading the answer with the next message, on Windows.** The laptop's Watcher got "What did that say?" and finished its turn, but its reply was not read. It is proved on forge only, above.
- **The installed apps.** The run above used the published build beside them, not an update of them.
- **A Mac.** Nothing here ran on one.
- **Two desks on Windows, a Mac or two tailnets.** The desks ran on forge only. They use the same link, listener and credential store as the laptop run, but `read-desk` itself has not crossed between two computers.
- **A merge order from two real desks with real pull requests and checks.**
- **Two tailnets.** Drake's computer is not on Zach's tailnet, and only Tailscale's documentation says that device sharing carries Serve between them (`tailscale.com/kb/1084/sharing`, `kb/1312/serve`). A shared machine cannot start connections unless the sharing goes both ways, and the guide says to share each way. The first real link between Zach and Drake is the proof.
- **A provider other than Claude Code** answering on two computers. Codex and Grok Build's side calls are ADR-0026's, tested in their own suites; Devin cannot be Watcher.
