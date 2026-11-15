# A thread can be snoozed until a time

## Status

Accepted November 1, 2026, at Drake's request. It is an Owl feature (`thread-snooze`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), Drake's call. No mock-up: it adds an affordance to the sidebar row, which already exists, and a shelf built the way Settled is. Drake chose the menu's choices, and that a thread that needs you wakes early.

Amended November 5, 2026, at Drake’s request: the host shares snoozes with the iPhone and other desktops. Snooze remains an Owl feature.

Amended November 10, 2026: by status ([ADR-0201](0201-the-threads-sidebar-groups-open-threads-by-status.md)), the Snoozed shelf lists its threads as one flat list, newest activity first, each naming its project, with no project folder (Zach's call); by project it lists them under their projects as before. A thread that wakes comes back to Working now or Recent rather than to its project folder.

## Context

Settled puts work aside until the user brings it back. Some work is waiting for a time rather than a decision: a review to look at tomorrow morning, a deploy to check this evening. Left open, such a thread crowds the project folders; settled, it is forgotten. The sidebar had no way to put a thread aside until a time.

## Decision

**1. Snooze puts an open thread on the Snoozed shelf until a time.** A clock icon among a row's hover icons opens a menu beside the row: **For 1 hour**, **This evening** (6 pm, offered before 5 pm), **Tomorrow** (9 am), **Next Monday** (9 am, left out on a Sunday, when it is Tomorrow) and **Pick a date and time…**, which opens a date and time field beside the row. Each choice shows when it wakes. The row menu (ADR-0164) offers **Snooze…**, which opens the same menu, so the keyboard reaches it too. A snoozed thread's row stands on the **Snoozed** shelf above Settled, under its project, with **Until** and its wake time where the row's time would be. The shelf shows only while a thread sleeps, starts folded, and opens while searching, as Settled does.

**2. A thread wakes at its time, when it needs you, or when the user wakes it.** At its time it is back in its project folder, when the host’s timer expires (or the client’s clock when disconnected). A thread waiting for an approval or an answer wakes then and for good, so answering it does not send it back to sleep. **Wake now**, the clock icon on a snoozed row and in its menu, wakes it at once. Finishing a turn alone does not wake it. Settling a snoozed thread puts it on Settled, which wins.

**3. Snoozes belong to the host that owns the thread.** The coordinator persists the thread’s Sotto ID and UTC wake time beside its other thread records. It publishes optional `snoozedUntil` on the thread, and advertises `thread-snooze` only while its Owl gate is on. `snooze-thread` sets the time or clears it with `null`. The host wakes a thread permanently for a question, permission request or unseen failure, including one in its delegation. Finishing alone leaves the snooze intact. Settled still wins while the thread is settled.

**4. Clients share that answer.** The desktop keeps its existing controls and migrates a future `sotto.threads.snoozes` entry to a supporting host before removing the local entry. An older host retains the local fallback. The iPhone shows **Snoozed** above **Settled**, grouped by project, newest activity first, initially folded and expanded by search. Rows show **Until** and their wake time. Snoozed threads leave the other groups and their counts; questions and permissions always take precedence. A retained offline snapshot expires locally too. The iPhone adds no snooze or wake actions in this change.

## Consequences

- Watcher and notifications still see the thread’s actual work and requests. Snooze changes its list placement, not execution or permission policy.
- Protocol version 1 is unchanged: the new field is optional, old phones ignore it, and new phones treat an absent field as no shared snooze. Old hosts cannot share the window’s legacy snoozes.
- The host’s Owl gate controls availability. A current iPhone paired to a supporting Owl host sees its snoozes. Stable hosts omit the field and capability, show no snooze controls, and preserve saved snoozes for a later Owl run.
