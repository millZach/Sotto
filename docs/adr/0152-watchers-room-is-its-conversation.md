# Watcher's room is its conversation

## Status

Accepted October 27, 2026. Zach asked for it: "I want to remove these little guys up here. Please remove the watched and visualize features as we only use the threads view. Also, I would like to add the same accent glow to watcher when it needs you that the little owls have." He reviewed `docs/prototypes/watcher-without-tabs-prototype.html` and picked the glyphs-only glow, no glow for a failed turn alone, All threads for the "+N" pile, and the room switch and its pages moved to where the tabs were. Supersedes [ADR-0106](0106-watchers-picture-reads-what-the-window-holds.md). Watcher has been on stable since 0.1.40, so this goes straight through to both tracks.

## Context

Once Watcher ran, its header held three icon tabs beside All threads: **Conversation**, **Watched** with a count badge, and **Visualize**. Watched put a card for each watched thread in the conversation's place. Visualize put **Watcher's picture** there: a night across the pane's whole width with a tree for each computer and an owl for each watched thread, and the merge turns along the top (ADR-0106). The picture needed a read of its own from main, and Watcher marked the sends that gave a merge turn so the picture could show them. Watcher also had Sotto's visual tool, to draw in its own conversation.

Zach only uses the conversation. The watched threads are already in the night scene's margins, in All threads and in the needs-you line.

The night scene's thread owls glow in the accent while their thread waits on the user. Watcher's own owl did not change when something waited.

## Decision

**1. The room is the conversation.** The three tabs go. Once Watcher runs, the header holds the tile, Watcher, All threads and the way off the page (decision 6), then Stop all while it shows. The Watched view and Visualize go with them. Watching does not change: Watch in a pane's header and the owl in a sidebar row or an All threads row still start and stop a watch.

**2. What only the picture used goes too.** The merge turns read (`sotto:watcher:read-merge-turns`) and send_to_thread's `mergeTurn` mark are removed. The merge workflow itself stays: read_state still works out the merge queue, and READY TO MERGE, GO MERGE and MERGED still come from the pull request's facts and Watcher's sends.

**3. Watcher draws no visuals.** Its scoped tools are its pull request babysitting alone. Project threads keep the visual tool as [ADR-0056](0056-an-agent-can-draw-a-visual-in-its-thread.md) and [ADR-0060](0060-an-interactive-visual-runs-in-a-sealed-page.md) describe.

**4. The "+N" pile opens All threads.** It used to open Watched. A press on a thread owl still opens its thread beside Watcher's conversation. The owls stay out of the tab order; All threads is the keyboard's way to the same threads.

**5. Watcher's owl glows while something waits on the user.** It glows the way a waiting thread owl does: every glyph in the accent, in the same four slow steps, held on the middle step with motion reduced. There is no wash behind it; on an owl this size the thread owls' wash read as a panel. It glows while Watcher's own thread has a question or permission waiting, or while a thread in Needs you waits on a question, a permission or a prototype to review. A failed turn alone does not light it, as it lights no thread owl; the needs-you line still names it. The scene paints the change in place, so it never blinks (ADR-0126).

**6. The way off the page takes the tabs' place.** Zach asked for the room switch and the More menu to move to where the tabs were, then drew the row he wanted: the switch (Dictate, Watcher, Threads), a hairline, then Usage, Settings, Help and the update control as presses of their own, the row the sidebar's foot draws. So it sits right after All threads, and More is gone; Memory joins as a link while memory is on, as it does in the foot, so nothing More held is lost. Stop all stays at the header's right end. This replaces the header's end from Drake's pick of October 26, 2026 (D of `docs/prototypes/watcher-head-strip-prototype.html`).

## Consequences

- The night scene no longer steps away. It shows whenever the room and Watcher's conversation can be read.
- Main does less: no merge turns in memory, no watched rows kept for a read, no admission hook on a send.
- A Watcher that still sends `mergeTurn` is refused for an unknown field. Nothing reads it now, and its tool description no longer mentions it.
- History and replay of the picture (#1340) have nothing left to replay.
- A watched thread on a host the user has disconnected is not in All threads, so the desktop offers no way to stop that watch until the host is back. The user can still ask Watcher to stop watching it, or stop it from the iPhone's Watched list.
