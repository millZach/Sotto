# First-run setup is notes on the real pages

## Status

Accepted November 10, 2026, by Zach's picks on question cards that day, from the prototype kept as the tag `prototype/guided-setup` (`docs/prototypes/guided-setup-prototype.html` there). It supersedes decisions 1, 3, 5 and 7 of [ADR-0063](0063-first-run-setup-covers-the-agents-and-ends-in-the-threads-tour.md). ADR-0063's other decisions stand, on the pages the walk now visits.

## Context

Zach asked for first-run setup to be reworked on November 10, 2026. Setup was walked that day in the built app on Linux, in the test build and with the real clients in an empty home folder. From what the walk found he named three faults he had seen on Windows, Linux and the Mac:

- **The coding agents step.** Each client reported its problem in its own words ("Codex disconnected before acknowledgement."), no row offered a way to sign in, and at the default 1080x720 window the list scrolled with Check again below the fold.
- **Dead ends.** With no agent connected the project step had nothing to press, and setup ended on an empty Threads page with a red error.
- **The tour afterwards.** Four notes that skipped Dictate, Watcher, Usage and Help and spoke of keys setup no longer asks for.

He also asked for four smaller faults to be fixed: buttons cut off by the card's footer, the Add host dialog as setup opened it, the iPhone step without Tailscale, and wording slips. Length and order were not his complaint.

## Decision

**1. Setup is a walk of notes over the real pages.** There is no setup card and no strip page. A new profile opens on the Threads page, and each stop lights one real control, dims the rest of the window, and puts a note beside the control. Of three drawn variants (notes on the page, a guide docked beside the page, one line across the top) Zach picked the first. A note says what the stop is for in a sentence or two, where the stop stands, and offers **Back**, the way forward and **Skip setup**. The way forward reads **Continue** once the stop's task is done and **Skip for now** until then, as ADR-0063 had it.

**2. The stops, in order.**

| Stop | Real page | Lit control |
| --- | --- | --- |
| What Sotto is, and how it looks | Threads | none; the note is centred |
| Sign in to a coding agent | Settings › Providers | the provider list |
| Add a project folder | Threads | the sidebar's Add project |
| Start your first thread | Threads | New thread, then the composer |
| Set up Sotto in Omarchy (Linux) | Settings › Dictation | the Omarchy panel |
| Check your microphone | Settings › Dictation | the microphone test |
| Choose a speech model | Settings › Dictation | the speech model list |
| Try the shortcut | Dictate | the Dictate room |
| Tailscale | Settings › Hosts & phones | the Tailscale row |
| Run threads on another computer | Settings › Hosts & phones | Add host |
| Answer threads from your iPhone | Settings › Hosts & phones | the Phones group |
| What is left | Threads | none |

The first note carries the welcome's sentence, its privacy lines and the look: **Light**, **Match Windows** (or the system's name) and **Dark**, which repaint the window at once. Themes stay in Settings › Appearance.

**3. Setup's first part is done when a first thread is open.** Everything after it is optional, and the note there offers **Continue to dictation** and **Finish here**. A project and a thread need a connected agent, so when none is ready **Skip for now** on the agents stop passes over both and goes on to dictation rather than stopping at a page with nothing to press. The last note lists whatever was not done and where each lives.

**4. Sign in is the dialog paired hosts already have.** A provider that is installed and not signed in gets **Sign in** on its folded row in Settings › Providers, for every user and not only during setup. For Codex, Claude Code and Grok Build a press runs the client's own sign-in on this computer and finishes it in the browser, in the dialog a paired host's tile opens ([ADR-0037](0037-a-hosts-providers-are-connected-and-signed-in-from-this-computer.md)): a page and a short code, or a code to paste back. Devin and Muse sign in from their own command, so their rows show it with **Copy**. When a sign-in ends, Sotto checks the provider again. This replaces ADR-0063 decision 3's "signs in to nothing": Sotto still holds no credential, and the sign-in is the client's own, started on the user's press. A provider that is not installed keeps **Install guide**.

Zach first picked a terminal running the client's sign-in command, and the prototype draws that. It would have needed a terminal that belongs to no thread ([ADR-0111](0111-terminal-mode-is-removed.md) calls that a new decision) and main typing a command on stable ([ADR-0139](0139-a-command-in-a-reply-runs-in-the-terminal-drawer.md) holds that in Owl). Told so, he picked the dialog instead, and neither record changes.

**5. Provider rows say where they stand in the same words.** Not signed in, Not installed, Too old to use, Can't be started, for every provider; a connected one keeps the page's own word, Connected. The client's own sentence stays in the opened row and is not the row's status. A problem Sotto has no word for still reads Needs attention, with the client's sentence under the row, and Cursor's row keeps its own design ([ADR-0128](0128-cursor-is-a-thread-provider.md)).

**6. The Threads tour is removed,** with its glossary entry. The walk's notes over the sidebar and the composer say what its first three notes said.

**7. New users see the walk, and Help starts it again.** A profile without `onboardingComplete` gets it; Reset settings shows it again, as before; and Help's **Set up Sotto** starts it for anyone. Skip setup and the last note both set `onboardingComplete`.

**8. The smaller faults, on the pages that own them.**

- Add host is opened from its own page, where Threads is reachable, so its offer to have an agent set the host up is true again. Until the setup card goes, the dialog it opens says only "then add it". Escape closes the dialog in one press while its device list is as it opened; a list the user has moved in from the keyboard, opened, or come back to from a typed host closes first, as before. The pointer passing over the list does not make it the user's, since the list opens under wherever the pointer already is.
- **Get the iPhone beta** moves from the setup card to the Phones group in Settings › Hosts & phones. The card keeps its own until the card goes, so setup is never without a way to the app. **Let phones connect** does not stay on when Tailscale is missing; it says phones need Tailscale, and the Tailscale row above it has Get Tailscale. That is for a press that turns it on: the press asks Tailscale first and saves nothing when it is missing, so nothing is left on if the page closes meanwhile. A switch already on when Tailscale goes away stays on, as a failed step with Try again, so phone access comes back with Tailscale. The setup card's own switch follows the same rule until the card goes, with Get Tailscale beside it.
- A note never covers the control it lights, and nothing clips at 820x560.
- The first note names the agents this build offers, and every path is written with ›.

**9. The product events notice follows the walk,** as it followed the tour ([ADR-0179](0179-sotto-sends-product-events-unless-turned-off.md)).

**10. Straight to stable.** It is not an Owl feature.

## How the walk behaves

Settled while building it, from the picks above and from what setup did before.

- **Escape ends the walk, as Skip setup does,** as it ended the tour. Zach picked this on November 10, 2026, over Escape doing nothing and over Escape working only for a walk started from Help. An Escape the lit control uses for itself, or a dialog it opened, is not also the walk's.
- **Set up Sotto is a card of its own at the top of Getting started in Help,** under that heading and above its topics, as the built page he was shown had it; his pick over a topic row and over the side panel. Started from there, the walk's quiet button still reads Skip setup.
- **A note counts every stop,** his pick: "2 of 12", then "5 of 12" when the walk passes two over, as the prototype counted.
- **A lit control that leads to another page leaves the walk waiting in the corner.** Add host's Open thread goes to Threads, where its agent asks its questions, and Dictate's Open Settings goes to Settings. The dim lifts, the page the user was sent to is fully live, keys and all, and a small note in the window's corner says setup is waiting, with **Back to setup** and **Skip setup**. Zach picked this on November 10, 2026, over standing aside until the user returns, ending the walk, and withholding the way out. The walk's own move to a stop's page is not being led away: a stop waits only once its own page has shown.
- **Only the note and the lit control are live.** The dimmed window takes no presses, and Tab goes through the note, then the lit control, and round. The control is the page's own: pressing it does what it always does, and a Tab or an Escape it uses for itself, as the composer does to take a suggestion, is not also the walk's. No key reaches the window's own shortcuts while a note shows, so a page shortcut or F6 cannot move the page out from under a stop.
- **The lit control's own popups have the window too.** A menu it opens, or a list inside it that reaches past its box, such as the composer's file and skill suggestions, is drawn with nothing of the walk over it.
- **A dialog the lit control opens has the window to itself.** Sign in, the folder browser, Add host and a host's SSH question are drawn with nothing of the walk over them, and the note comes back, with focus, when they close.
- **In a narrow window the sidebar is a rail,** and Add project and New thread are behind its Expand sidebar. The project and thread stops light Expand sidebar there and say to open the sidebar first; the opened sidebar is a dialog over the page, so the walk stands aside for it.
- **Arriving at the agents stop connects every agent installed on this computer,** as the card's step did (ADR-0063 decision 3), once per walk, leaving Threads quiet.
- **The dictation stops are passed over while dictation is turned off,** and are not listed as left. While an OpenRouter speech model transcribes ([ADR-0160](0160-dictation-can-be-transcribed-by-an-openrouter-speech-model.md)) the speech model stop is passed over, and the first note says neither that speech is transcribed on this computer nor that audio never leaves it.
- **The stops use the pages' own controls as they are.** The microphone stop lights Settings' test, which listens until it is stopped, so the walk stops it on moving on; the note says it heard a voice as soon as the test has. The speech model stop lights Settings' list, where a model downloads when it is chosen, not the three Download rows the prototype drew. The list has no strong button for a suggestion, so the note names the model setup suggests while none is chosen (ADR-0094): the first already on this computer, else Parakeet Ultra.
- **A microphone the test never opened waits for Settings' test,** as a skipped microphone step did: ending setup then saves `microphoneSkipped`.
- **Quitting part-way starts the walk from its first note next time,** as the card did. The stops whose task the app can still see as done read Continue; the microphone test is not remembered, as the card's was not, so it is asked for again.
- **A control too large to leave the note a side gives way to it.** The note takes the corner farthest from the control's middle and the lit box is cut back, so the note still covers nothing lit. No stop needs this at 820x560 or above today.
- **The Tailscale stop reads the Hosts page's own row,** so a connect made there shows in the note at once.
- **Started again from Help, the walk is the same walk,** and ending it saves nothing.
- **The starting screen and the corner cards wait for setup to be over,** as before.

## Consequences

`Onboarding.tsx`, its step components, `ThreadsTour.tsx` and their stylesheets go, and the walk is `src/renderer/src/features/setup/`; `localAgents.ts` and `microphoneTest.ts`, which Settings also uses, move to `agents/` and `audio/`. The `onboarding` page value goes with the card: a new profile's window is on Threads from the start. The Omarchy panel loses its `first-run` surface. The end-to-end helpers that walk setup are rewritten around the notes, the design captures of the nine steps and the tour are retaken as captures of the stops, and `first-run-setup-fit.spec.ts` becomes a check that every note fits beside its control at all four window sizes, light and dark. `README.md`, `docs/guide.md` and `CONTEXT.md` describe the walk. The work lands in three pull requests so stable never ships half of it: Sign in and the row words; the Hosts & phones and Add host fixes; then the walk, which removes the card and the tour.
