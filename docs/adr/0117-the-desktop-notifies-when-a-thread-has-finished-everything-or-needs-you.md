# The desktop notifies when a thread has finished everything or needs you

## Status

Accepted October 22, 2026. Drake Morey asked for notifications on the Mac: one when a thread is completely finished, with no reviewer or advisor still working, no background work and nothing else going on, and one when a thread needs an answer. He chose each of these when asked: an Owl feature first, macOS only, a thread that babysits a pull request counts as still waiting, and both switches on by default. Builds on [ADR-0046](0046-the-host-keeps-a-finished-thread-unread-until-a-client-shows-it.md) (**Finished unread**), [ADR-0051](0051-the-iphone-takes-the-glow-look.md) (the iPhone's alerts, whose rules and words it copies, except in one place: the iPhone's alerts start off and iOS asks when the first is turned on, while these start on and macOS asks at the first notification), [ADR-0081](0081-a-thread-may-delegate-work-to-threads-it-starts.md) (delegation) and [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md) (Owl features). Holds [ADR-0004](0004-authority-in-policy-records.md). **Number provisional until merge** (docs/agents/domain.md).

## Context

Sotto on the desktop shows nothing outside its window. A thread that asks a question, or finishes, while the window is behind another app waits until the user looks. The iPhone already has local alerts (ADR-0051), but only while Sotto is open on the phone. The host already marks a thread **Finished unread** when its turn and any background work end while no client shows it. That mark is not enough for "completely finished": a thread can rest while a delegated reviewer still works, while it babysits a pull request, or a moment before a queued message or a hidden news turn starts it again.

## Decision

**Two notifications.** On a Mac, in Owl, the desktop shows a macOS notification:

- **Needs you**: when a thread asks a new question or permission. Several new requests in one thread at once make one notification. It fires at once, with no delay.
- **Finished**: when a thread is **wrapped up**. It fires once for each finish.

Settings has a **Notifications** group with two switches, **When a thread needs you** and **When a thread has finished everything**, both on by default. A switch is read when a notification would show, so turning one off stops it at once, and nothing that happened while it was off is shown later.

**Wrapped up.** A thread is wrapped up when it is **Finished unread** (ADR-0046) and nothing it started is still going: nothing babysat, no delegated thread working or waiting on the user, no monitoring task, no background work, no request waiting, and nothing on its way to send, neither a follow-up nor a wake-up (a paused or failed message does not hold it back). A sub-agent that is working holds it back like background work, and so does one **last seen working**, which a restart could not see end. It must still be so after a 3 second settle delay, read again from the newest state, or 15 seconds for a thread that delegated work: a delegated thread's answer returns to it as a turn Sotto sends later, which no queue shows, and that send can wait, or retry after ten seconds. The delay covers the gaps that look like a finish: a delegated thread's answer going back as the delegating thread's hidden news turn, a provider starting its own report-back turn after background work, and a queued follow-up about to go. A failed or stopped turn is not a finish. A thread that was already marked when Sotto started, or when its host first connected, notifies nothing for that mark, and a request already there then notifies nothing either.

**Whose finish counts.** A delegated thread, a reviewer or an advisor, never notifies as finished; the thread at the top that delegated it does, once everything below it is done. A delegated thread's question still notifies, under its top-level thread's title, and pressing it opens the thread that asked, where its card is. Watcher's own thread never notifies as finished. Nor does a **watched thread**: Watcher keeps it going and brings the user its questions and permissions, so its finish is not the last word. Its questions and permissions still notify. A settled thread notifies nothing.

**The thread on screen is quiet.** A thread the window shows never notifies: one of its panes, or its pinned Tools thread, while the window has the focus. This is the same rule as **Finished unread** and the iPhone's alerts.

**The desktop router is the seam.** Main watches the state the desktop host router publishes. It already joins every host's threads, this computer's and each paired host's, in one place, so one watcher covers them all. The headless host never imports the router, so Electron never reaches it. Hosts change nothing and are asked nothing new.

**What a notification says.** Its title is the thread's title. Its body is one plain line: the agent and what happened, such as "Codex is asking a question.", "Claude Code is asking for permission." or "Codex finished.", with "on" and the computer's name when more than one computer is connected and the thread runs on another one. It never carries a question, a reply or a path.

**It answers nothing.** A notification has no buttons and no reply. It answers, approves and sends nothing for the user, so ADR-0004 holds. Pressing it brings Sotto's window forward and selects the thread and its project. Watcher's own requests open its room, since Threads hides that conversation. A cleared thread or another computer's Watcher room leaves an available thread open with a line explaining why the destination could not be shown. Sotto's own sends do not replace the user's send notices. Clarified October 31, 2026 after a notification selected Watcher's hidden conversation and left Threads empty.

**macOS.** Electron 42 and later show notifications through macOS's UNNotification. Checked on October 22, 2026 with a throwaway Electron app: macOS shows them only for an app it can find and validate, such as one installed in Applications: the app that worked was registered with Launch Services in `~/Applications`. The same app run from a temporary folder, or Electron started by `npm run dev`, is refused ("Failed to find or validate client"), and Sotto gets a `failed` event, which it handles quietly: no error, no banner, one log line. An ad-hoc signed app in Applications was accepted: it was found, macOS asked for permission, and the notification was delivered to Notification Center. So stable Macs, which are ad-hoc signed, can show them, and so can Owl Macs, which are Developer ID signed. Not checked: a banner from Sotto's own packaged build, and whether a banner shows while Sotto is the app in front. The first notification makes macOS ask whether Sotto may show them. Settings has **Send a test notification** and the line "If nothing appears, allow Sotto in System Settings → Notifications." Sound follows System Settings; Sotto sets none.

**Where it runs.** macOS only, through a platform profile flag; Windows and Linux are unchanged. It is the Owl feature `desktop-notifications`: stable shows and starts nothing of it.

## Consequences

- A paired host older than ADR-0092 never marks a finish in a pane while the window is unfocused, so it sends no Finished notification for such a thread.
- The iPhone and the Mac each notify from their own view. A thread can notify on both, or on one only, since each counts only what it shows itself.
- No notification for a failed turn. A prototype waiting for review (ADR-0108) gets no Needs you notification of its own; its thread notifies as Finished like any other. Both are follow-ups.
- A thread that delegated work notifies its finish 15 seconds after it is wrapped up, not 3. The news that sends it back to work is not in any queue a client sees, so the longer wait is a margin, not a hold: if that send takes longer than 15 seconds (two failed tries, or a history that will not load), the thread can be told finished early, and again when the turn the news started ends. Publishing a text-free "news waiting" flag from the coordinator would close it, and is left for later.
- Notification Center keeps what Sotto shows under macOS's own settings, so a thread's title can stay there after the thread is settled.
- It contacts no host and no service. Notifications are made on this computer from state the desktop already has.
