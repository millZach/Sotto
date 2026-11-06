# A Codex history line longer than one frame (#2268)

November 5, 2026, on forge. Branch `fix/codex-lost-app-server`, from `493a8e1a0`.

## What was seen

Thread `d77f6bd5` (Codex 0.166.0, GPT-6 Astra) had made 106 paintings with Codex image generation in one turn. At 19:55:57 Pacific it called `request_user_input`. Its rollout ends there, with no answer recorded.

Codex keeps its own log in `~/.codex/logs_2.sqlite`. The thread's app-server was PID 77607, not PID 2789: 2789 is the provider's app-server, and its only lines in that window are `list_models`. The last request 77607 logged is Sotto's, at 19:56:05:

```
2026-11-06 03:56:05|TRACE|codex_app_server::message_processor|app-server request: thread/read connection_id=ConnectionId(0) request_id=Integer(7)
2026-11-06 03:56:05|TRACE|codex_rollout::recorder|... Resuming rollout from ".../rollout-2026-11-05T17-26-56-01a1ae77-4c9f-7272-b167-d60320e60f7c.jsonl"
```

Nothing more came from 77607. There was no OOM or earlyoom kill and no core dump in that window. Sotto's stored turn says `"status":"failed","error":"Codex stopped before this reply finished…","completedAt":"2026-11-06T03:56:07.126Z"`. Later app-servers 391650 (19:57:06) and 394603 (19:58:34) each resumed the same thread. The host's own output goes nowhere (`launchScript.ts` starts it with `stdio: 'ignore'`), so forge holds no Sotto host log.

## Measured on the real thread

A throwaway client started its own `codex app-server --stdio` (0.166.0) and sent only `initialize` and a read-only `thread/read` for the thread's Codex ID. It sent no resume and no turn.

| Read | One reply line |
| --- | ---: |
| `includeTurns: true` | 357,417,246 bytes (340.9 MB), in 1.7 s |
| `includeTurns: false` | 3,950 bytes |

By item type, the 340.9 MB were 106 `imageGeneration` items: 340.5 MB of it was their `result` field, each picture's base64 bytes. Each item also names its `savedPath`. `CodexProcess` ended an app-server when one line passed `MAX_FRAME_BYTES`, 128 MB. Codex 0.166.0 cannot page this history: `thread/items/list` answers `-32601 thread/items/list is not supported yet`, and `thread/turns/list` finds a single turn.

The same reply, fed chunk by chunk through `OversizedLine` as Node delivered it, kept **353 KB** in **150 ms**. It parsed. All 106 picture strings were empty, all 106 still named their `savedPath`, and all 43 agent messages were whole.

## Tests

- `tests/integration/codexSessionProcesses.test.ts`, **keeps a thread's app-server, turn and question when a whole read carries more picture bytes than a line may hold**. It uses a 64 KiB line and four 32 KiB pictures. Before the fix, the read rejected with "Codex disconnected before acknowledgement." A throwaway probe on the same scene, since removed, showed the rest of the forge chain. The turn failed, the question was dropped, and the next send was refused as "Codex history could not be verified before sending the prompt". Each later read started a new app-server and killed it again: 4 app-servers and 4 whole reads. After the fix the read succeeds, the question is answered on the same app-server, and the next send is accepted.
- `tests/unit/main/workspaceStoreWriter.test.ts`, **gives Watcher the thread's stored history, as unavailable, when its provider cannot read the thread back**. It failed with "Codex disconnected before acknowledgement." before the change to `watcherRead`.
- `tests/unit/main/codexOversizedLine.test.ts`: chunk splits down to one character, escapes, data URLs, long text kept, and a line still too long that fails only its own request while the app-server keeps going.

`npm run typecheck` and `npm run lint` passed. Targeted Vitest runs with `--maxWorkers=2` passed:

| Files | Tests |
| --- | ---: |
| `integration/codexSessionProcesses`, `integration/codexAdapterBoundary`, `unit/main/codexOversizedLine`, `unit/main/threadMedia`, `unit/main/threadMediaRouting`, `unit/main/threadMediaScheme`, `unit/main/workspaceStoreWriter` | 144 |
| `unit/main/heldProviderGate`, `unit/main/museWatcherGate`, `integration/watcherPairedHosts` | 209 |
| `integration/adapterContract`, `unit/main/codexActivity`, `integration/codexActivity`, `integration/codexUnreadableNotification` | 65 (37 skipped) |

GitHub CI runs the full suites.
