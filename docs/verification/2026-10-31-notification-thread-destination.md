# Notification destination, October 31, 2026

Drake reported a notification opening the Threads empty state around 15:55–16:05 MST on `0.1.42-owl.20261031.2` (`b00aa6ae`). The installed version at investigation was `0.1.43-owl.20261031.2` (`bde56ebfe`). This is a read-only runtime investigation and unit verification, not a check in the running app.

## Retained evidence

`logOperational` in `src/main/index.ts` writes `[Sotto] <event>` to `console.error`. The installed process's stdout and stderr were both `/dev/null`, confirmed with `lsof -nP -a -p 33887 -d 1,2`. There was no separate operational-log file. macOS's unified log query for process Sotto and notification events during 15:50–16:10 returned no rows. The notifier did not record a notification click's thread ID, so no retained record proves that a particular notification caused a particular selection.

The retained `~/Library/Application Support/sotto/turns.jsonl` records these commands. MST is UTC minus seven hours.

| Line | MST | Command | Result |
| --- | --- | --- | --- |
| 2808 | 16:00:37.950 | `manual-send` to the Watcher thread below | Completed at 16:00:38.180 |
| 2809 | 16:02:07.885 | `select-thread` for the same thread | Completed at 16:02:07.900; no failure code |
| 2810 | 16:04:11.644 | `answer` for the same thread | Completed at 16:04:11.737 |
| 2815 | 16:07:34.466 | `manual-send` to the same thread | Completed at 16:07:34.713 |

The thread is `3a5c9a9e-4ec8-47b5-b911-921627cc5777`. The retained workspace identifies it as `kind: watcher`, provider `claude`, in project `native:claude:project:5181b9d8-d7c1-4699-b20d-8097b7691db6`, named **Watcher**, at `~/Library/Application Support/sotto/watcher/workspace`. Its saved title matches the screenshot's notice: “Sotto has news of watched threads. It is in the note that…”. Its owning host is `193491f7-8fa8-4b0d-a5b0-e6f5546cd492`, so the desktop router's key is `host:193491f7-8fa8-4b0d-a5b0-e6f5546cd492:3a5c9a9e-4ec8-47b5-b911-921627cc5777`.

`threads.sqlite`, opened read-only, also holds an `answer-given` event, sequence 55932, at `2026-10-31T23:04:11.687Z` for request `3b4dba93-1c96-4e84-9f7d-cc6708c5b7ca` on that thread. No prompt, answer or permission text was copied into this note.

## Cause and limits of the conclusion

The best-supported incident explanation is a notification for Watcher's own question. Its selection time matches the report, a question was answered in that room two minutes later, and the exact room title appears in the screenshot. This remains an inference: the click itself was not retained.

Both the desktop router and the coordinator already set the selected thread's project. The relevant notifier, tracker, coordinator, router and renderer files were unchanged between the two reported commits. A different project alone does not explain the empty page.

The old notification callback always selected the target and then told the renderer to show Threads. `withoutRoomWatcher` removes Watcher's current conversation from that page; `withoutThreads` clears its visible selection and project. `EmptyWorkspace` then renders “Choose a thread.” while preserving `state.notice`. The alert tracker intentionally allows Watcher's questions and permissions, while excluding its finished alerts.

Separately, `sendManual` wrote “Sent to …” even for commands carrying Sotto's own origin. The targeted coordinator test reproduced that overwrite. The retained `manual-send` turn records do not identify their caller, so they cannot prove which caller produced the screenshot's notice.

## Change and verification

Notification navigation now opens the current Watcher conversation in Watcher without selecting its hidden row in Threads. Ordinary notifications continue selecting both the thread and its project. A cleared thread, another computer's Watcher room, or a failed selection gets a useful destination and a dismissible explanation. Earlier Watcher conversations remain readable in Threads. Notification clicks still answer and approve nothing (ADR-0004).

Sotto-originated manual sends, reconciliation and steering preserve the user's existing notice. User sends, including phone steering, keep their acknowledgements.

The pre-fix targeted run reproduced the Watcher destination mismatch and the automated send's notice overwrite. The cross-project coordinator assertion passed. Node 25.8.2's experimental Web Storage also broke the repository's test cleanup; subsequent individual Vitest runs disable it with `NODE_OPTIONS=--no-experimental-webstorage` without changing repository setup.

Final check results are recorded in the pull request. No Sotto app was launched, no native notification was pressed, no visual capture was made, and no full local CI gate ran. Native notification delivery, focus and appearance await the packaged macOS check. GitHub CI is the remaining gate. The Update-all failure pill is outside this change; no evidence connected it to notification navigation.
