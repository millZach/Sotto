# Claude native thread adapter — issue #22 verification

Verified September 11, 2026 with the installed native Claude Code **2.1.268**. The implementation is `ClaudeStreamJsonHost` in `src/main/agents/claude.ts`, wrapped by the existing `SottoThreadHost` in production.

## Protocol evidence

Inspected the installed `claude --help` and ran a metadata-only stream-json `initialize` control request. The native response reported the installed client's model aliases and effort levels. Subscription verification uses the existing `ClaudeSubscriptionClient`: safe-mode `auth status --json` must report a Claude subscription; Sotto does not read credentials, inject API keys, change account directories, or switch billing.

Primary source protocol references inspected:

- [Anthropic Python SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py): `control_request`, `control_response`, initialize, interrupt, can-use-tool responses and request cancellation.
- [Anthropic subprocess transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py): native stdio framing, resume and session flags.
- [Anthropic native session reader](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py): project path sanitization and authored-user filtering.
- [Claude SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input): AskUserQuestion handling through the permission callback.

Coding launch arguments are `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode default --permission-prompts host`, plus `--session-id <native UUID>` for an empty thread or `--resume <native UUID>` once the native transcript exists, `--model <installed alias>` and optional `--effort`. Coding processes retain tools, user configuration and native transcript persistence. The isolated reasoning client's tool-disabled flags are used only for its metadata discovery probe, never coding threads.

Tool answers preserve the native envelope. Explicit Allow sends `{behavior: 'allow', updatedInput: originalInput}`. Deny, missing approval, interruption and disconnect send `{behavior: 'deny', message: ...}`. No permission-rule changes or session-wide grants are synthesized. AskUserQuestion returns updated input with `answers` keyed by the exact question text. Malformed permission/question requests deny; unsupported control subtypes receive an error response. Only `approval-required` is advertised; unsupported runtime modes reject before dispatch.

## Durable identity and recovery

`claude-threads.json` maps the adapter-facing reserved session alias to a separately generated native Claude UUID, project, directory, title, model/effort and dispatched-message metadata. Origins contain message/command IDs, native message UUID, SHA-256 text digest, timestamp and optional image references (name/type/byte count). They contain no prompt text, transcript copy or base64 image data. `claude-projects.json` stores project metadata. Sotto IDs remain in the shared thread registry.

The native UUID is saved before creation is reported; creating an empty thread needs no model turn. Prompt origins are saved before writing stdin. Native replay acknowledges delivery; timeout or transport failure remains uncertain and never resends. Snapshot reconciliation reads only the native transcript for known Sotto-created UUIDs. Missing history after a dispatched prompt prevents recreation. Restart restores conversation state with idle status, not a killed process.

The native session reader tails bounded JSONL frames and keeps only in-memory normalized user/assistant messages. It ignores tool results, sidechains, injected metadata, compact summaries and known generated user entries. Own message UUIDs and dispatch digests distinguish Sotto-origin messages from CLI-authored input. A foreign authored message has no command ID and invalidates the running adapter's context, so the next accepted send attaches through native resume. Guarded stale replies reject before dispatch. Existing unrelated user histories are never discovered or imported.

Saved threads hydrate from native history without spawning a CLI for every thread. Native runtimes attach for explicitly observed threads or on send. Disconnect denies pending requests, closes stdin, then terminates unresponsive adapter children. It does not terminate a separately launched native CLI.

## Verification performed

- Shared adapter contract: **9/9 passed**, no skipped cases, against a real child process speaking the scripted native protocol.
- Focused safety/recovery suite: **13/13 passed**. Includes malformed requests, explicit-only approval, multiple questions, takeover filtering, image-only prompt acknowledgement/restart with references, uncertain-message deduplication, stale-context resume, unsupported modes, and SottoThreadHost registry identity across restart.
- `npx tsc --noEmit -p tsconfig.node.json` and focused ESLint passed.
- Live native metadata initialization succeeded without a user prompt.
- Live synthetic CLI turn returned `SOTTO_SYNTHETIC_OK`; observed native replay, streaming events, assistant result and synthetic session-log entry shapes.
- Live **actual adapter** smoke passed subscription/model discovery, create, send acknowledgement, streamed assistant result (`SOTTO_ADAPTER_OK`), same native UUID resume with identical restored messages, a separate native CLI `--resume` prompt, takeover detection and stale-reply rejection. It used the native default model and existing subscription. No API funding fallback was attempted. The first smoke exposed a streamed assistant timestamp mismatch after restart; adopting the final native timestamp fixed it and the complete smoke then passed.

The explicit opt-in probe is `tests/fixtures/claudeLiveProbe.ts`. Bundle it with the already installed esbuild for Node, then run the output with `SOTTO_CLAUDE_LIVE=1`. It creates a fresh temporary project and native synthetic history and prints its temporary root. It does not delete native history or inspect any pre-existing user transcript.

## Limits

The independent spec review found that IDE context followed by an authored prompt was being filtered as metadata. The filter now follows the native session reader's complete-entry IDE pattern; regression tests cover both opened-file and selection context, preserve metadata-only filtering, and reject a stale automatic reply after the mixed-content takeover.

Permission/question/cancel error paths are validated against the primary-source protocol fake, not a live coding tool invocation. The live takeover used a separate headless native CLI with `--resume`, not the interactive terminal UI. Parent integration owns rendered Sotto UI verification and provider selection.

Takeover detection is limited to the known native transcript format. A missing/locked log can delay observation. Identical external text can be indistinguishable from a pending same-text dispatch or consecutive native duplicate entries; UUID matching is preferred. The adapter reports its own process status and cannot reconstruct a separate CLI's running process solely from transcript entries. Existing user-defined native hooks, permissions and account settings continue to apply. The native version field is populated when the CLI emits its system/init frame; a resumed metadata-only runtime may not emit that frame before the next prompt.

## Independent-review follow-up

Three regression scenarios reproduced before their fixes: observed-thread initialization could be bypassed by an immediate send (both delayed and rejected initialization), an external user message arriving during origin persistence did not stop a guarded send, and a valid image replay larger than 1 MiB disconnected the native protocol.

The adapter now shares the pending initialization promise before returning a runtime, repeats log polling and the latest-user guard immediately before dispatch, and durably removes only the rejected undispatched origin. The retry regression confirms no native user frame or origin survives the rejected dispatch and a deliberate retry against the new user message succeeds. Native stdout and transcript frame limits now derive from the shared 20 MiB aggregate attachment allowance after base64 expansion, plus 1 MiB for protocol/prompt metadata. Stderr retains its separate 1 MiB cap. The image-only regression replays and restores a native frame larger than 1 MiB without storing image data in Sotto recovery metadata.

After these fixes and the IDE-context takeover correction: shared contract 9/9, focused regressions 15/15, Node typecheck and focused ESLint passed. No additional live paid turn was needed; native protocol fields were unchanged.
