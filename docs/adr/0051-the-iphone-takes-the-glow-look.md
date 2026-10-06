# The iPhone takes the Glow look

Accepted October 4, 2026. Zach found the iPhone app's type and spacing uneven, its surfaces flat and colourless, and its movement abrupt, and asked for a redesign in Sotto's own character. From five whole-app studies (Layers, Glow, Editorial, Soft and Timeline) he chose **Glow**, asked for its Threads page to scroll as one sheet the way Soft does, and chose version B of three thread pages. He kept the question sheet and New thread as Glow drew them and approved the refined study as the app's new look. The studies are on `prototype/iphone-glow-redesign` under `docs/prototypes/iphone-redesign/`; `glow-refined.html` is the approved one.

This amends [ADR-0039](0039-the-iphone-opens-on-focus-threads.md). Its navigation stands: Threads, Computers and Settings, questions and permissions first, Settled collapsed. What changes is how the app looks and moves, the thread page, and what Settings holds.

## The look

The chosen theme colours the room. Each tab opens on a soft wash mixed from the theme's accent; a thread that needs the user warms it, and the wash scrolls away with the page. Questions and permissions carry a warm glow, working threads breathe with a faint accent halo, and a failed thread has a faint danger edge. The tab bar, the thread's pinned bar and the reply box are frosted glass. Type and spacing come from one scale each, set in Figtree. Screens push and pop, sheets rise over a receding screen, and an answer reads Sending, then Answered, before its card leaves Needs you. Reduce Motion turns movement into fades and stops the breathing; Reduce Transparency turns glass into solid surfaces.

## The thread page

The Messages and Activity tabs are gone. The agent's steps (reading, editing, running commands) sit in the conversation in time order, each a small muted line under a faint guide, and the running step ticks at the end. Messages are placed by the time the host already sends with them and steps by their start time, so nothing new crosses the protocol. Only a slim bar stays pinned: back, a status pill, and the title once the big one has scrolled off. The big title, the provider and computer, and a row of chips for the branch, its changed lines and its pull request scroll away with the conversation. The chips read the Git status the host already puts on the thread's worktree record; checks are left for the Git work that follows. While the reply keyboard is open the top stays one line.

Messages render as blocks (headings, lists, code blocks, paragraphs) with inline Markdown inside each block, as the desktop does, so a stray backtick can no longer turn the rest of a message into code. A key chord such as Ctrl+` reads as a key, not as the start of a code span.

## Settings on this iPhone

Settings now holds the theme (Sotto's six palettes, each in light and dark, drawn from the desktop's own definitions), appearance (Dark, Light or System, Dark by default), text size in five steps, message density, notifications, defaults for new threads, and About. Everything stays on this iPhone and changes no computer's settings. Text size never goes below a size iOS asks for through its accessibility settings; the earlier Larger text switch carries over as the Larger step.

Notifications are local. While Sotto is open it can alert when a thread needs the user, when one finishes, or when one stops with an error, and never for the thread on screen. Sotto drops its connections when it leaves the screen, so nothing arrives after that. Each is off until the user turns it on, and turning the first one on is when iOS asks for permission. An alert while the app is closed would need Apple's push service and a relay the computer reports to, which is a new host; that is a separate decision and not made here. **Play a sound**, from the approved study, adds a sound to the alerts that are on; it asks iOS for nothing itself and waits until one of them is on.

New-thread defaults choose the model, effort, permissions and working copy that New thread starts on. A default applies only where the chosen computer offers it; otherwise the computer's own saved choice applies, as before. A permission default that lets a thread act without asking applies only while that computer lets this iPhone answer (ADR-0033); otherwise the thread starts asking and New thread says why. Working copy may be the project's shared folder or a new worktree, which sends the `workingCopy` field the host's allow-list already accepts.

## Answering on a card

A question with a few one-tap choices, or a permission, can be answered on its card in Threads again, as the approved study draws it. This amends ADR-0039's "Requests are opened and answered in their thread": the card's top still opens the thread to read the whole request first, and the sheet in the thread is unchanged. A card reads Sending, then Answered when the computer confirms the answer through its own receipt, or No longer waiting when the request left without that (a desktop answer, a stopped turn), before it leaves. Nothing here answers for the user; ADR-0004 and ADR-0033 decide who may answer, as before.

Working cards show the step running now only for a thread whose detail this iPhone has read, because the thread list the computer sends carries no steps; otherwise they show the thread's state and how long it has been working.

## What this does not change

No host, listener, protocol version, runtime dependency or command is added. Authority stays where ADR-0004 and ADR-0033 put it: nothing here answers a request for the user.

## October 5 amendment: steps fold into one line

On a busy thread the inline steps buried the messages: dozens of "Reasoning summary" and "Command" lines between two replies. Zach asked for them to shrink to one line that shows the thread is working and opens to show them all, and chose **B · Pulse** from three live effects in `steps-folded.html` on `prototype/iphone-glow-redesign`.

Each run of steps between two messages is now one line. While the run is the thread's working one, the line shows the step running now (its verb, its subject and how long it has run) in the accent, or Thinking between steps, since a provider reports its tool calls and not the thinking between them, with a breathing dot, the step rolling up like a ticker as the next replaces it, and the number of steps so far. Once the run has ended, the line reads how many steps it had and how long it took ("14 steps · 1m 32s") in quiet type. A failed step changes nothing on the folded line; it shows as it did, in the opened list. A press opens the run's steps in place, as the guide-and-lines trail above, and another press folds them. Under Reduce Motion the line is a still accent line that crossfades. What this paragraph replaces is only how steps are shown: they are still placed by time between messages, and nothing new crosses the protocol.

## October 6 amendment: what the look may cost

Scrolling grew laggy with the Glow look, and Zach chose to keep the look and make it cheap. The rules that came out of it: no SwiftUI `.shadow` (it redraws its blur whenever its view moves, even for a clear colour; `SoftShadow` draws one once instead), no `repeatForever` SwiftUI animation (it evaluates its views every frame; loops run in Core Animation through `LoopingView`), and no `UIHostingController` inside the app's views for them. Measured in [the idle CPU note](../perf/2026-10-06-iphone-idle-cpu.md), a still thread fell from 0.32 s of CPU in three seconds to 0.05 s and Threads from 0.54 s to 0.02 s, with the look unchanged.

## October 6 amendment: what an update may redraw

The look's cost was not the only lag. Every change published on `AppModel` redraws every view that watches it, and a working thread's computer sends up to forty updates a second, so while any thread worked the whole app was redrawn that often. The rules that came out of it: state that changes many times a second lives in a store of its own that only its readers watch (`DraftStore` for the reply boxes' words, `DetailStore` for the open thread's history); the model publishes a computer's state only when it changed; a view handed a closure says with `Equatable` what it draws from, so its parent's redraw can skip it; and a looping layer is given its colours only when they change. On iOS 18 and later the thread page never follows new words while the user drags or flicks it, and catches up when they let go at the bottom. Measured in [the publishing note](../perf/2026-10-06-iphone-publishing.md), a streaming thread fell from about 2.8 seconds of CPU in three seconds to between 0.03 and 0.3 on Threads and to between 1 and 2 in the thread, with the look unchanged.
