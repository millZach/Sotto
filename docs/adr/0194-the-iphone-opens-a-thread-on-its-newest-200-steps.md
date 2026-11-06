# The iPhone opens a thread on its newest 200 steps

## Status

Accepted November 5, 2026. Zach's picks on November 5, 2026, on the question card for the iPhone's history: option B of the `ios-earlier-history` prototype (tag `prototype/ios-earlier-history`, `artifacts/prototype-ios-earlier-history/index.html`; open on the newest steps with every message between them, and **Show earlier messages** at the top adds more), 200 steps, and straight to stable.

Amends [ADR-0016](0016-sotto-owned-history-on-an-event-store.md)'s **history window** for phones. A desktop's window is unchanged. Fixes #2242.

## Context

A thread opens on its newest ten turns, the same on a desktop and a phone (`FIRST_WINDOW_TURNS`). That keeps a thread of many short turns small, but it does nothing for a thread of a few long ones. The design loop thread on forge has 15 turns, and its last five hold 2,000 steps, the most a thread keeps (`MAX_AGENT_ACTIVITIES`), with 680 pictures among them. Ten turns is all of it: opening it sent the iPhone 1.09 MB of uncompressed detail, about 1 MB of it step summaries, and the phone laid out every row.

The same thread moved under its reader. At the 2,000-step cap each new step drops the oldest, so while it works, picture rows and run lines leave the top of the iPhone's page, and the rows below move up by what left (#2242). In the simulator a held row moved 180 to 568 pt in 15 seconds of work. The desktop's browser keeps its place through that, as it does through any change above the reader; the iPhone's scroll view does not.

The window is the host's, shared by everything that observes the thread, so a phone can't hold less than a desktop beside it without the host cutting what it sends that phone.

## Decision

**1. A phone opens a thread on its newest 200 steps.** A client whose hello accepts `step-window` is sent each thread's detail from the message just before the oldest of its newest 200 steps: that message, every message after it, those 200 steps and the turn records. A run longer than the window is cut inside, so the window holds 200 steps however long the run. The iPhone places those steps after the window's first message by their times, as it does now. The detail says there is more above (`earlierAvailable`) and how many steps (`earlierSteps`). A thread with no more than 200 steps in its history window is sent whole, as before.

**2. The window keeps its top while the phone observes the thread.** The host keeps, for each client and thread, the message the window starts at and the oldest step's sequence. Every whole it sends later starts there again, so a working thread's window grows at its end and never loses rows at its top, and a delta leaves out a record or a change to a message above it. The steps the cap drops sit far above a 200-step window, so a phone that hasn't read back that far is not moved by them. A window that has held no step yet, such as a stored thread's whose steps arrive a moment after its messages, is cut afresh when they come. When the client stops observing the thread, the window goes, and the next open starts at 200 steps again.

**3. Show earlier messages adds 200 steps.** The phone sends `earlier-steps`, and the host moves that client's window back to 200 steps more than it holds, the steps its deltas brought included. While the thread's own window holds too few, the host widens it with `load-earlier-messages`, as a desktop's press does, twenty turns at a time and at most 25 times, then cuts it. It answers with the thread from the new start, at the revision the phone may already hold, and the phone puts that in place of its copy. Under the button the phone says how many steps are above, with the words a folded run uses ("1,796 steps").

**4. Nothing else changes.** A desktop, an Android phone and an iPhone on an older build don't accept `step-window` and are sent the whole history window. A host that doesn't list it gets the old command from an iPhone. A picture still loads only when its tile scrolls near the screen.

## Consequences

- Opening the design loop thread sends the iPhone 91 KB instead of 1.09 MB. Other long threads on forge drop from 239–1,078 KB to 138–236 KB. In the simulators its shape opened in 1.5–2.3 s instead of 5.4–12.2 s, at 72–94 MB instead of 325–390 MB, and a held row stayed within 0.2 pt while the cap dropped steps (`docs/perf/2026-11-05-iphone-step-window.md`, `docs/verification/2026-11-05-iphone-step-window.md`).
- A phone reading back to the cap's edge, nine presses up in the design loop thread, is moved by the cap's drops again. The fix for that would keep the reader's place in the page itself, which this does not do.
- The window's top can show a run that started above it: its folded line counts only the steps inside the window.
- Each phone costs the host a small record per observed thread, and a whole sent to it a cut of the detail (under 2 ms for 2,000 steps).
