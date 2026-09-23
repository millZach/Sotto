# Sidebar says a thread waits on you when nobody else is watching it

September 22, 2026. When a Claude Code thread asked through AskUserQuestion, its question card appeared above the composer and could be answered, but the Threads sidebar row showed no ring and no **Needs your answer**. A permission on the same kind of thread was just as silent.

## Cause

The row's `needs` state came only from the attention queue. The coordinator fills that queue from its assignments: `acceptSnapshot` walks `state.assignments` and enqueues a thread's requests there. A thread you started and prompted yourself has no assignment, so its requests never reach the queue, with the voice coordinator on or off. The composer never had this problem, because `ThreadPane` built the same request from `thread.requests` when the row had none.

## Fix

`describeThreads` now reads the thread's own pending requests whenever the queue has no question or permission for it, in the same shape `ThreadPane` used to build. The row, its ring, the collapsed rail's title and the composer all read one derivation, and `ThreadPane` no longer builds its own. The attention queue stays the coordinator's ordering of the threads with an assignment; making it hold every thread would have let the coordinator present and narrate threads it has no assignment for.

## Verified on Windows

- `tests/integration/threadRowAttention.test.ts` drives the fake Claude process through `AgentControl`: an AskUserQuestion, then a Bash permission, on a thread with no assignment. It failed on `origin/main` with the row reading `Done` while `thread.requests` held the request and the queue held nothing, and passes with the fix, including clearing after the answer.
- `tests/unit/renderer/threadSidebarStatus.test.tsx` covers a request with no queue item, for both kinds, in the expanded row and the collapsed rail, and a question on a managed thread that supervision is still deciding, which the row also shows as **Needs your answer** because the question is still yours to answer until either answer lands.
- `tests/e2e/thread-sidebar-question.spec.ts` in the built app: a question arrives on Workshop while Docs is open, with the voice coordinator off, at 1280x800 in dark; a permission the same way with the voice coordinator on, at the 820x560 minimum in light. Each shows the ring and the label in the row and the rail, and clears once answered from the thread. Against a build without the fix both fail with the row reading `Working`.

## Evidence

- [Question, row, 1280x800 dark](../../artifacts/sidebar-question/question-1280x800-dark.png)
- [Question, collapsed rail](../../artifacts/sidebar-question/question-1280x800-dark-rail.png)
- [After answering](../../artifacts/sidebar-question/question-answered-1280x800-dark.png)
- [Permission, row, 820x560 light](../../artifacts/sidebar-question/permission-820x560-light.png)
- [Permission, collapsed rail](../../artifacts/sidebar-question/permission-820x560-light-rail.png)

## Limits

The floating widget's thread list carries no waiting state per thread, so it has nothing to change. Its attention list is the coordinator's queue and still shows only threads with an assignment, as before. The row's sentence under a waiting thread is the provider's last message, or the request's text when there is none, as it was for queued requests.
