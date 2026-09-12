# Issue 24: actual native Threads UI acceptance

Verified on Windows, September 12, 2026, using the production Electron build of `afa135f` in an isolated worktree. This closes the earlier evidence gap between deterministic renderer tests and separate adapter/CLI probes: these runs used the actual Threads page, coordinator, thread registry and native adapters together.

| Native provider | Model selected from native catalog | Actual UI smoke |
| --- | --- | --- |
| Codex App Server 0.154.0 | gpt-6-astra, xhigh | Passed, 12.3 seconds |
| Claude Code | default, provider default effort | Passed, 15.3 seconds |
| Grok Build 1.0.5 / ACP 1 | grok-4.6 | Passed, 10.2 seconds |

Each run created a fresh project and thread through the rendered New thread dialog, selected Ask for approval, and sent one text-only prompt through the composer. The prompt requested exactly `READY` and prohibited tools, file reads, file modifications and other actions. A DOM mutation observer captured the actual `Sending…` pending message without delaying or replacing native acknowledgements. The UI then displayed exactly one confirmed authored message and the `READY` assistant reply, removed the pending message, and cleared the composer. No managed assignment or tool request was present, and the synthetic project directory remained empty.

Each application was closed and relaunched with its own profile. The same Sotto thread ID, complete registry binding and native provider session ID survived. The reply and one authored message reappeared in the Threads page. Reply screenshots for all three providers were inspected at the native Windows window size: transcript, title, composer and provider controls remained readable and contained.

## Reproduction

`tests/e2e/native-threads-live.spec.ts` is opt-in and has no automatic retries. A fresh run uses one native subscription turn per provider. The test fixture `tests/fixtures/nativeThreadsMain.cjs` synchronously selects a fresh temporary Sotto profile and substitutes only the native folder picker with its empty synthetic project. It then loads the actual built main entry point. It does not inject an adapter, coordinator state, provider event, model reply, membership, or E2E bridge. The fixture rejects packaged launches and non-owned temporary roots; production source and packaged E2E guards are unchanged.

```powershell
npm run runtime:prepare
npm run build
$env:SOTTO_NATIVE_THREADS_LIVE = '1'
# Optional: run only one provider (codex, claude, grok).
$env:SOTTO_NATIVE_THREADS_PROVIDER = 'codex'
npx playwright test tests/e2e/native-threads-live.spec.ts --workers=1
```

The generated `artifacts/native-threads-live/<provider>/evidence.json` records the synthetic root, model catalog, thread, observed pending text and restoration evidence. Screenshots are `create.png`, `sending.png`, `reply.png` and `restart.png`. These artifacts remain local. The `sending.png` capture can occur after fast native acknowledgement; the mutation observer independently verifies the pending frame.

To inspect an existing synthetic thread against a newer build without sending another turn, select its provider and set `SOTTO_NATIVE_THREADS_RESTORE_ROOT` to the exact synthetic root printed by the original run. The same test then verifies the saved binding, one user message and visible reply, and writes `restored-latest.png` plus `restore-evidence.json`. Clear that variable before a fresh full smoke.

The profiles and native synthetic histories are retained for diagnosis, never deleted by the harness. Native clients keep their normal account directories and subscription authentication. Codex's own `login status` reported ChatGPT authentication before its run. No credential content, personal transcript or unrelated project was inspected, and no API-account fallback was used. Speech output and reasoning are disabled in the isolated Sotto profile. Existing native hooks/settings still apply; no blanket approval option is passed.

## Supporting checks and limits

Node typecheck, focused harness lint and runtime verification passed. A fresh worktree initially failed normal startup because Git checkout line endings changed the tracked runtime JavaScript bytes while the runtime manifest requires exact hashes. `npm run runtime:prepare` restored installed-package bytes and generated the ignored WASM files; its three tracked runtime paths had no normalized content diff. No generated runtime changes are included in this change.

The unpackaged app reported an already-registered global hotkey and missing wake-model setup. Neither affects these typed Threads journeys; no audio capture or playback was exercised. This is Windows unpackaged acceptance, not packaged or macOS verification. Live permission/question/tool execution, cancellation, and external CLI takeover were not repeated; the existing [Claude](../research/issue-22-claude-native-verification.md) and [Grok](../research/2026-09-11-issue-23-grok-acp-verification.md) reports and adapter contract suites remain the evidence for those separate paths.
