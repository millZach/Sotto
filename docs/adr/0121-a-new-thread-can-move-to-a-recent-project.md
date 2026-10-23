# A new thread can move to a recent project

## Status

Accepted October 23, 2026, as an Owl feature (`recent-projects`). Extends the **Greeting** (Zach's pick on October 14, 2026, variant a of `docs/prototypes/new-thread-greeting-prototype.html`) and [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md) (Owl features). **Number provisional until merge** (docs/agents/domain.md).

## Context

A new thread opens in the focused pane's project. When that is the wrong project, the user had to leave it, find the right project in the sidebar or the New thread picker, and start again. The greeting already names the project under its line, at the place the user is looking before the first send.

## Decision

**1. The greeting's project is a menu.** On Owl, the project under a new thread's greeting is a button that opens a menu: the other projects on the same host with work in them, newest work first, up to five, then **Choose another folder…**. A project counts as having work when one of its threads has a time. Settled projects and the thread's own project are left out.

**2. Choosing starts there, as New thread would.** A project in the menu asks the Threads page for a new thread in that project, the same request the pen beside a project row makes, so an unused thread there is reused. **Choose another folder…** opens the New thread project picker. The thread the user left stays empty, unlisted, for New thread to reuse. Nothing moves between projects and nothing is sent.

**3. The keyboard path is the pane menu's.** The project is one Tab stop named "Change project, now <project>". Enter or Space opens the menu with focus on its first row; Up, Down, Home and End move; Escape or Tab closes it and returns focus to the project. No shortcut is claimed.

**4. Stable shows nothing of it.** The renderer asks `useOwlFeature('recent-projects')` before drawing the menu; with it off the project is plain words, as before. Main has no part.

## Consequences

The menu reads only what the window already holds (the host's projects and threads); nothing is fetched to fill it. Sending the feature to stable flips its entry's `sentToStable`.
