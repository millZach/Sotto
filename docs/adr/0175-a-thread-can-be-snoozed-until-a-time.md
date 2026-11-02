# A thread can be snoozed until a time

## Status

Accepted November 1, 2026, at Drake's request. It is an Owl feature (`thread-snooze`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), Drake's call. No mock-up: it adds an affordance to the sidebar row, which already exists, and a shelf built the way Settled is. Drake chose the menu's choices, and that a thread that needs you wakes early.

## Context

Settled puts work aside until the user brings it back. Some work is waiting for a time rather than a decision: a review to look at tomorrow morning, a deploy to check this evening. Left open, such a thread crowds the project folders; settled, it is forgotten. The sidebar had no way to put a thread aside until a time.

## Decision

**1. Snooze puts an open thread on the Snoozed shelf until a time.** A clock icon among a row's hover icons opens a menu beside the row: **For 1 hour**, **This evening** (6 pm, offered before 5 pm), **Tomorrow** (9 am), **Next Monday** (9 am, left out on a Sunday, when it is Tomorrow) and **Pick a date and time…**, which opens a date and time field beside the row. Each choice shows when it wakes. The row menu (ADR-0164) offers **Snooze…**, which opens the same menu, so the keyboard reaches it too. A snoozed thread's row stands on the **Snoozed** shelf above Settled, under its project, with **Until** and its wake time where the row's time would be. The shelf shows only while a thread sleeps, starts folded, and opens while searching, as Settled does.

**2. A thread wakes at its time, when it needs you, or when the user wakes it.** At its time it is back in its project folder, within the sidebar clock's half minute. A thread waiting for an approval or an answer wakes then and for good, so answering it does not send it back to sleep. **Wake now**, the clock icon on a snoozed row and in its menu, wakes it at once. Finishing a turn alone does not wake it. Settling a snoozed thread puts it on Settled, which wins.

**3. Snoozes belong to this computer's window.** They live in the renderer's `localStorage` under `sotto.threads.snoozes`, each thread's Sotto ID with its wake time, the way starred models do (ADR-0147). A snooze whose time has passed is ignored and dropped on the next write. Nothing in main reads them: the threads, their providers and their hosts are untouched, and nothing is sent anywhere.

## Consequences

- Main does not know a thread is snoozed. Watcher still sees it, and the desktop's notifications (ADR-0117) still fire for it. A thread that needs you wakes anyway; a thread that finishes while snoozed still says so.
- The iPhone and other desktops do not see snoozes. If that is wanted, a snooze becomes host state the way Settled is, which is a new decision.
- Stable shows no icon, no menu entry and no shelf, and keeps the record an Owl build saved; turning the feature on brings back the snoozes still to come.
