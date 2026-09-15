# Issue 74: Codex personal-chat timeout audit

The combined native run timed out after 120 seconds in `personalChatsNative.test.ts`. Its one owned synthetic conversation had already completed in approximately four seconds and persisted as accepted/idle. The old test wrote evidence only after `service.close()` in `finally`, so the timeout did not retain its last awaited step. The exact original wait is unknown; this audit does not attribute it to provider response latency or claim a production fix.

## Recovery without another send

The original owned root, `C:\Users\zache\AppData\Local\Temp\sotto-personal-native-hiBtCU`, was recovered through the real `PersonalChatService` and `CodexAppServerHost`. A temporary ignored diagnostic in `.claude/tmp/native-personal-restore.test.ts` wrapped each awaited operation and rejected any `thread/start` or `turn/start` RPC. It connected, resumed, read the existing thread, settled persistence, disconnected, and separately awaited the host's stopping, frame, writing and usage barriers before closing the service.

The first recovery passed in 1.39 seconds. A second recovery added explicit equality checks for native thread ID and each message's ID, command ID and text; it passed in 1.19 seconds. Neither recovery created a conversation or submitted a prompt. The original root remains intact. Checkpoints are retained in [original-restore-checkpoints.json](../../artifacts/issue-74-native-personal/original-restore-checkpoints.json).

```powershell
npx vitest run --config .claude/tmp/native-personal-vitest.config.ts --reporter=dot
```

## One fresh authorized probe

After recovery, one additional fresh probe was authorized and run without automatic retry, retaining the original `gpt-6-astra` / `high` model and no-tools synthetic prompt. It passed in **6.807 seconds**. Exactly one `thread/start` and one `turn/start` occurred; native and message identities matched after restart, with no replay. Codex was version 0.154.0; the skill catalog contained 58 entries and zero errors.

Measured operations: initial connect 160ms, local send acknowledgement 4ms, dispatch settled 726ms, completed-turn refresh 41ms, first host close 55ms, restored connection 477ms, restored refresh 23ms, final close 1148ms. Provider-reported turn duration was 3946ms. See [fresh-checkpoints.json](../../artifacts/issue-74-native-personal/fresh-checkpoints.json).

```powershell
$env:SOTTO_NATIVE_PERSONAL_CHAT = '1'
npx vitest run tests/integration/personalChatsNative.test.ts --reporter=verbose
```

## Harness improvement and limitation

The native test now persists its step before entering each lifecycle wait, records duration or failure after it, bounds individual waits, saves evidence before final cleanup, and preserves the owned root when the test or cleanup fails. This fixes the demonstrated diagnostic gap: evidence is no longer stranded behind the very shutdown call being investigated. Final cleanup failure is reported without masking an earlier test failure. The final test adds the same checkpoint wrapper around local setup and completion polling as well; those extra wrappers were linted without purchasing another native turn.

`npx eslint tests/integration/personalChatsNative.test.ts` passed. No production service or adapter changed because neither read-only recovery nor the one fresh run reproduced the timeout. A future recurrence will identify the pending step, but the original timeout's cause remains unverified. This is successful native recovery and a passing fresh sample, not proof that an intermittent lifecycle problem was fixed.
