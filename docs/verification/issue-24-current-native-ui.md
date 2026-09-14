# Issue 24: current native Threads acceptance

On September 14, 2026, the Windows production Electron build at main `0e12b1c` passed all three actual native Threads journeys in `tests/e2e/native-threads-live.spec.ts` (3 passed, 1.0 minute). No production changes were necessary for these journeys.

| Provider | Installed native catalog selection | Result |
| --- | --- | --- |
| Codex App Server 0.154.0 | GPT-5.6-Luna, low reasoning | Create, send, reply, restart passed |
| Claude Code | Haiku, provider default effort | Create, send, reply, restart passed |
| Grok Build 1.0.5 / ACP 1 | Grok 4.6, low reasoning | Create, send, reply, restart passed |

The harness now explicitly enables and connects only the selected provider, selects a ready economical model when available, verifies the rendered model choice, and chooses low reasoning from the actual catalog. Each fresh journey sent exactly one prompt asking for `READY` with no tools, file reads, changes, or other actions. Automatic retries remain disabled.

Each journey used the rendered New thread folder picker and form, sent through the actual composer, observed the pending Sending state, and received one confirmed user message plus the native assistant's `READY`. The composer cleared and pending message disappeared. The thread had no managed assignment or pending tool request. The synthetic project directory remained empty. After closing and relaunching the application, the complete thread registry binding and native session identity were unchanged, and the one authored message and reply remained visible.

Restart screenshots for all three providers were inspected at the normal Windows window size. Thread title, selected project, reply, model controls and composer were readable and contained. The removed Tools rail stayed absent. These are current integrated UI/provider results, supplementing the [September 12 native report](issue-24-native-threads-ui.md).

The first Claude completion snapshot caught the streamed reply before its final result event; its restarted state was idle. The harness now waits for idle before taking the completed snapshot and shutting down, and also checks idle after restart. Restore-only follow-up runs reuse these same profiles without submitting another prompt.

## Reproduction and evidence

```powershell
$env:SOTTO_NATIVE_THREADS_LIVE = '1'
npx playwright test tests/e2e/native-threads-live.spec.ts --workers=1 --reporter=line
```

The runtime assets and production build must be prepared beforehand as described in the older report. The fixture launches the real main entry point in a guarded owned temporary profile; only its folder picker is substituted. Native adapters, coordinator, registry, IPC and renderer are real. The test asserts that no E2E bridge is present. The normal Sotto profile and open user app are untouched.

Local artifacts remain under ignored `artifacts/native-threads-live/{codex,claude,grok}/`: `evidence.json`, `create.png`, `sending.png`, `reply.png`, and `restart.png`. Each evidence file records the exact retained synthetic root, selected model, messages, pending observations and restored binding result. The fresh-run log is `.claude/tmp/issue24-native-ui.log`. Native account histories are retained; no credentials or personal transcripts are copied into the test profile or artifacts.

All three restore-only checks passed with the added idle assertion: Codex 2.9 seconds, Claude 9.2 seconds, and Grok 3.9 seconds. Each invocation skips the two unselected providers. The first restore-only Claude follow-up passed its binding, transcript, one-message, empty-project and idle assertions, then timed out while capturing a screenshot; one manual restore-only recheck passed. These follow-ups submitted no additional turns. The fresh Claude journey and its restart screenshot had already passed. Restore-only logs are `.claude/tmp/issue24-native-ui-restore.log` and `.claude/tmp/issue24-native-ui-restore-recheck.log`.

Focused harness lint passed. This report covers unpackaged Windows typed Threads journeys. It does not claim packaged/macOS verification or repeat physical microphone tests, live tool approvals, cancellation, or external CLI takeover.
