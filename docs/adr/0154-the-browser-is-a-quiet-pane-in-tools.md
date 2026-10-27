# The browser is a quiet pane in Tools, and its agent speaks in one line

## Status

Accepted October 27, 2026. Zach asked for Sotto's built-in browser to look and behave like the in-app browsers in Codex and T3 Code ("whenever an agent is using it, it really looks has way too much information"). He answered the clarifying questions, then picked variant A of `docs/prototypes/built-in-browser-pane-prototype.html` (tag `prototype/built-in-browser-pane`), kept the browser player for when Tools is closed, and asked for it on Owl first. The study behind it is `docs/research/2026-10-27-built-in-browser.md`. Amends ADR-0020 (where pages show, and the September 25 amendment's player) and ADR-0029 (where Stop sits). The Owl feature is `quiet-browser` (ADR-0072); stable keeps today's Tools > Browser, player and activity rows until Zach sends it.

## Context

Tools > Browser stacks a tab row, an address row with a viewport picker, the grant line, the task line with Pause, a fold of recorded steps and any request above the page, so the page gets what is left. In the thread, each browser call is an activity row of its own, and a running turn keeps its rows open, so an agent checking a sign-in shows dozens of rows. Codex and T3 Code put the page beside the chat under one row of controls, fold an agent's browser calls into one line, and let the user point at an element to tell the agent about it.

## Decision

**Tools > Browser is the browser pane.** It keeps its place in Tools and its rail tile. Above the page is one row: Back, Forward, Reload, the address with the page's title muted after it, **Point at something**, **Screenshot to message**, and a **More** menu. Pages show as tabs on a thin line above that row only when there are two or more. The More menu holds Open in system browser, the viewport size, and **Ask before this thread uses the browser**, which is ADR-0029's Stop under a name that says what a press does. With no page, the pane is an address field with the addresses the thread's browser opened this session under it, kept in memory only. The prototype's list of local servers is not part of this decision: finding them means reading the computer's listening ports, which is a decision of its own. A page the user made private still says so on a line of its own, with Share with agent, because that line is about what the agent can see.

**While an agent works on the page, one strip sits at the page's foot**: a dot, "Agent is browsing" and its last step in plain words, and Pause. A request waiting for the user (with the setting off) takes the strip's place with Allow once, Allow this thread to use the browser and Deny. Nothing else about the task stacks above the page; its steps are in the thread.

**The pane opens on its own.** When the focused thread's agent opens a page and Tools is open, Tools shows Browser and that page. When Tools is closed, the browser player floats as it does today, so the user can watch without opening Tools. **Show the browser when an agent opens a page** in Settings turns both off.

**The thread says it in one line.** A turn's calls to Sotto's own browser tools fold into one line that updates in place: "Browsing localhost:5173 · clicked Sign in" while they run, "Browsed localhost:5173 · 9 steps" once the turn moves on. Pressing it opens the steps in plain verbs, a failed one marked. Other tools keep their rows.

**Point at something.** The user presses Point and moves over the page; the element under the pointer is outlined and named (its tag and accessible name). A click takes a picture of the page at that moment and opens a short comment beside the element; **Add to message** puts the element, its picture and the comment in the thread's draft as browser feedback, sent only when the user sends it (ADR-0020). Escape closes the comment, and again leaves Point. The outline is Chromium's own inspect overlay, so no script is put into the page.

**Screenshot to message** adds a picture of the page to the draft, as Comment on page's capture does today, scaled to the screenshot bound (ADR-0030).

## Consequences

- The grant's Stop moves from its own line into More. It stays in Tools > Browser and still ends the thread's grant whichever its source; what it grants and how it ends are unchanged (ADR-0029).
- The browser player is unchanged and now shows only while Tools is closed for that thread's page, as it already steps aside while Tools shows the same page.
- Comment on page's region selection gives way to Point and Screenshot to message on Owl.
- Nothing new is sent anywhere: feedback is draft content until sent, as before.

## Amendment, October 27, 2026: the pane as built

The first of three pull requests builds the pane, the strip, Screenshot to message and the pane opening on its own; Point at something and the thread's one line follow. Where this record left room:

- **More keeps what the old tab line held.** Besides Open in system browser, the size and Ask before this thread uses the browser, it holds Share with agent or Stop sharing, Float the browser over the thread (while the player can take the page), and, while only one page is open and so no tab line shows, New page and Close page. The sizes are radio items, Fit the pane first.
- **Opening on its own never takes Tools from the user.** Tools turns to Browser only for a task Tools has not seen before, working, on the focused thread, while Tools is open on that thread and keyboard focus is not inside Tools. Otherwise the player floats, as it does with Tools closed.
- **The player stays away while Tools shows the thread's browser on any page**, not only the task's own, which is what "only while Tools is closed for that thread's page" asks.
- **The strip's last step says only what the action carries.** An action is a kind and coordinates, so a click reads "clicked in the page"; "clicked Sign in" waits for a step that records what it hit.
- **The addresses opened this session** are every address a page of the thread's browser arrived at, newest first (a page going back to an address moves it to the front), up to eight, in the renderer's memory only and only while the pane is on, so stable keeps none. A page still waiting to be opened has opened nothing.
- **A page the agent cannot see always says so.** Share lives in More, so the private line shows for any unshared page, with or without the grant, unless the thread's provider takes no Sotto tools or the page is still waiting to be opened. Stable keeps its line to pages made private under the grant.
- **A page the agent opens ends New page** when the pane turns to it, which happens only while focus is outside Tools, so nothing being typed is lost.
