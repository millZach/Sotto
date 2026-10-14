# Provider usage for Sotto's Owl dashboard

Researched October 12, 2026, followed by a bounded native metadata probe on the Windows laptop. No credential-file or provider-history reads, billed turns, installs, login/logout requests or account-setting changes were used. Official provider documents and source are cited below; unsupported fields must remain unknown rather than becoming zero. Live results are sanitized below and apply to the tested client versions, not every account or older release.

## What can ship honestly

Two distinct views make sense: **Subscriptions** shows the provider's account allowance and its next reset; **Activity** shows the work Sotto observed, with a clear coverage date. An allowance percentage is not a token budget, and an API-price estimate is not a subscription bill. This distinction also matters when the same account is used outside Sotto.

| Provider | Native allowance access without copying credentials | Activity data | Remaining verification |
| --- | --- | --- | --- |
| Codex | App-server quota read verified on 0.162.1; change notifications documented | Existing per-thread token notifications; current documentation also describes an account token summary | Installed CLI support for the newer account-summary method |
| Claude Code | Passive native rate-limit events; documented native status-line windows | Assistant/result usage and native history already read by Sotto | A supported idle quota refresh through Sotto's stream-json connection |
| Grok Build | `_x.ai/billing` verified on 1.0.50; reset period present, allowance percentage absent in the tested account response | Per-turn totals and per-model usage in published first-party source and Sotto's ledger | Availability/meaning of the omitted allowance percentage across account types |
| Devin | No structured account allowance method established by this research | Native session statistics are documented, including an ACP command | Machine-readable statistics schema and a safe account allowance reader |

The following provider sections support that table. A connection succeeds independently of whether its allowance can be read.

## Codex

Official OpenAI documentation defines `account/rateLimits/read` and `account/rateLimits/updated`. Prefer optional `rateLimitsByLimitId`; `rateLimits` is its older single-bucket view. Each window supplies `usedPercent`, optional `windowDurationMins`, and `resetsAt` in Unix seconds. Bucket labels, plan, workspace credits and earned resets are optional. Read the supplied duration rather than hardcoding five hours or a week. [Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

The same page documents `account/usage/read`: nullable lifetime/peak-daily tokens, turn duration and streaks, plus nullable daily token buckets. It requires Codex-service authentication; API-key-only and Bedrock accounts do not qualify. It does not document input/output/cache or model breakdowns for those account totals. `thread/tokenUsage/updated` remains the thread observation source. Current docs do not establish support in Sotto's tested CLI floor, so negotiate gracefully and retain the existing per-thread path. [Account usage and thread events](https://learn.chatgpt.com/docs/app-server).

Sotto already owns app-server processes and uses `account/read` without copying native sign-in. Add read-only requests through that owner rather than reading Codex credential files. Do not call the separate earned-reset consumption or notification-email methods: this feature requests observation only.

## Claude Code

Anthropic's current SDK source models native `RateLimitEvent`. Its wire parser accepts `type: "rate_limit_event"`, `rate_limit_info.status`, `resetsAt`, `rateLimitType`, `utilization` and optional overage fields. Utilization is a fraction, unlike Codex's percentage. Windows include `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` and `overage`; fields can be absent. The event describes rate-limit status changes, so it is evidence of the latest observed state, not a guarantee of periodic readings while idle. [Types at b6e9d12](https://github.com/anthropics/claude-agent-sdk-python/blob/b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c/src/claude_agent_sdk/types.py), [wire parser](https://github.com/anthropics/claude-agent-sdk-python/blob/b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c/src/claude_agent_sdk/_internal/message_parser.py).

The native status-line JSON documents five-hour and seven-day percentages and epoch-second reset times. They appear for Pro/Max after the first API response; either window may be absent, and expired windows disappear. This is a documented native observation surface, but configuring a status-line script is not evidence that stream-json exposes an idle control request. Do not replace the user's global status line to gain access. [Status-line rate limits](https://code.claude.com/docs/en/statusline#rate-limit-usage).

`/usage` distinguishes subscription plan bars from a session API-cost estimate. Its usage attribution is approximate local-machine history and excludes other devices and claude.ai. The native limit reader can be rate-limited and display a last-known snapshot with its age. Session totals reset on `/clear` in current releases. `/insights` spends model usage, so it is not a free dashboard import. [Claude Code costs](https://code.claude.com/docs/en/costs).

The Claude Platform Usage and Cost API is organizational API reporting, not an individual Pro/Max allowance reader. Its Admin API is unavailable for individual accounts and requires a suitable admin credential; Enterprise has a different Analytics API credential. Neither should be silently added to Sotto's existing native subscription connection. [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api).

**Recommended first version:** observe and validate the existing native `rate_limit_event` stream, keep timestamps and stale states, and offer the native usage destination when no fresh quota is available. A refresh button must not create a tiny paid inference turn to manufacture a reading.

## Grok Build

Published Grok Build source has an `x.ai/billing` extension handler and dispatch. The CLI performs its own authenticated backend fetch. Its optional config includes `creditUsagePercent`, `currentPeriod` (`type`, RFC 3339 `start`/`end`), `onDemandCap`, `onDemandUsed`, `prepaidBalance`, `isUnifiedBillingUser` and history. Prefer the percentage and typed period; legacy `monthlyLimit`, `used` and `billingPeriodEnd` remain fallbacks. `Cent.val` is USD cents, and an omitted proto3 zero becomes zero inside a present `Cent` object. A null config is supported. [Billing at 2bdd1d6](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/billing.rs), [dispatch](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs).

ACP reserves underscore-prefixed wire methods for extensions. `_x.ai/billing` is the verified wire method for this internal `x.ai/billing` handler on the tested installed client, described below. Unsupported-method responses must leave a useful unavailable state. No credential-file or private REST fallback is justified by this research. [ACP extensions](https://agentclientprotocol.com/protocol/v1/extensibility).

Source `UsageTotals` maps input/output from native prompt/completion counts, keeps cache-read/cache-creation counts separately, sums total tokens as input plus output, and defines cost as 10^10 ticks per USD. It also tracks model calls, reasoning tokens, API duration and whether cost is partial; child usage can be folded into its parent. Its session usage archive maintains cumulative totals across processes, while the extension reads the active session ledger. Verify whether Sotto's current turn frames carry every field before claiming coverage. [Usage totals](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-chat-state/src/usage.rs), [session usage archive](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/usage_file.rs), [usage extension](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/usage.rs).

Current X Subscription documentation describes a weekly pool shared across eligible first-party Grok/Cursor surfaces, with paid Additional Usage separate. Thus Grok Build's reported allowance may be account-wide beyond Build; do not label it a Build-only token limit. [Usage limits, updated October 11](https://docs.x.ai/x-subscription/usage-limits).

## Devin

Official CLI reference documents `/usage` as estimated session credits/ACUs and `/session-stats` as every server-reported dimension, including tokens, agent messages and continuations. Totals persist across resume; its Model row is the model that served billed turns, which may differ from the selection. `/session-stats` is advertised to ACP hosts. The documentation does not establish a structured result schema or an account-quota ACP method. Do not send it through `session/prompt` automatically until it is verified as a local, non-billed command and its response is handled separately from conversation activity. [Commands and ACP slash commands](https://docs.devin.ai/cli/reference/commands).

Pro/Teams full seats have calendar daily and weekly allowances; Max has a weekly allowance without a daily cap. These quotas cover sessions, CLI and Desktop. The exact next reset must still come from a real account read rather than a guessed local calendar boundary. [Self-serve quotas](https://docs.devin.ai/admin/billing/self-serve#how-quotas-work).

Devin documents overall usage and balances in Settings > Usage & limits, Enterprise consumption in separate administrative views, and per-session usage in Session Insights. Its billing units also depend on actions and infrastructure, so tokens are not interchangeable with ACUs. [Devin usage](https://docs.devin.ai/admin/billing/usage).

Public API usage metrics exist, but public API authentication uses a PAT or service-user key with appropriate permissions. The fact that native CLI login works does not establish a supported way for Sotto to retrieve that credential or call its API. [API authentication](https://docs.devin.ai/api-reference/authentication), [usage metrics API](https://docs.devin.ai/api-reference/v3/metrics/metrics-usage).

**Recommended first version:** include Devin's connection and Sotto prompt counts; label token and allowance availability explicitly until a safe native statistics reader is verified. Keep a provider usage destination available rather than inventing a percentage.

## Token normalization and coverage

Use **input** as all input tokens and **output** as all output tokens. Cache read/write are subsets of input, so **total tokens = input + output**, never input + output + cache read + cache write. For Claude, normalized input must add native `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`; Anthropic documents those as disjoint fields. [Claude token semantics](https://platform.claude.com/docs/en/api/rate-limits#cache-aware-itpm).

OpenAI's current response usage nests cache reads/writes under input-token details, and its input-price formula subtracts both from ordinary input. This supports the same subset convention; only show cache writes when the native Codex protocol actually provides them. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). Grok's source likewise defines total as input plus output, cited above.

Verified local source:

- [nativeUsage.ts](../../src/main/agents/nativeUsage.ts) already uses this normalized Claude input convention and keeps cache-write breakdowns in entries. Its aggregate `summarize` currently adds only input/output/cached; cache-write totals are omitted. Its entries have model and token counts but no per-entry time, prompt identity or origin. Date filters cannot faithfully backfill old entries from the ledger's most recent update time.
- The same ledger deduplicates observed native usage; Codex resets/replays can be marked incomplete. Claude child/sidechain frames are intentionally excluded. Grok turn usage may already include children. Counting parent plus child separately can double count. These coverage rules need to be visible in totals, not silently called all subscription activity.
- [threadUsage.ts](../../src/shared/threadUsage.ts) preserves optional counts and partial/persistence flags. Keep those semantics when aggregating; a reported zero and a missing field are different.
- [devin.ts](../../src/main/agents/devin.ts) has no `NativeUsage` integration, and its native version floor is recorded in [devinRpc.ts](../../src/main/agents/devinRpc.ts). This research did not inspect native session files to fill that gap.
- Thread-side writing can spend the thread's own subscription ([sideWriting.ts](../../src/main/agents/sideWriting.ts)); a dashboard should distinguish user sends, automatic side calls and native model requests if it records them. One prompt can contain many model requests and use multiple models.

Start dated aggregates when dated observations are available. Historical undated tokens may be shown as imported totals with a coverage note, not assigned to today. Count **prompts** from accepted user sends/dispatch records, not token notifications, assistant messages or tool calls. Report selected and actually observed model identities separately where routing exists.

## Remote hosts, privacy and refresh behavior

Every connected host owns its native login. Read allowance and usage on that host through its provider adapter, then return only normalized numbers, units, timestamps and safe labels. Existing [host provider policy](../adr/0036-a-host-connects-every-signed-in-provider-it-can-find.md) and [Devin policy](../adr/0017-devin-native-provider-data-policies.md) apply. The renderer still has no network.

Do not add percentages from two hosts: the same account can appear on both, and the provider reading already includes activity outside Sotto. Where native account identity cannot be safely established, retain host labels and avoid claiming deduplication. Offline hosts need an observed-at timestamp and a stale state; old numbers must not look current. This is an implementation inference, not a provider contract.

Keep subscriptions and stored numeric observations behind the Owl feature list ([ADR-0072](../adr/0072-sotto-owl-is-a-windows-preview-release-track.md)). Stable must start no readers. Prefer native notifications, an initial read when the page opens, and coalesced bounded refreshes. A quota refresh reads metadata; it must not consume inference, modify billing, enable overage, top up credit or grant any permission. New direct network destinations or credential handling would require an ADR/README decision before implementation.

## Useful dashboard additions

Recommended first additions are daily activity, models ranked by input/output tokens and prompts, cache-read share (reported cache read / normalized input), tokens per prompt, provider/project/host filters, active threads, and visible coverage/staleness. API-equivalent cost can be optional and clearly labeled; preserve the rate version and partial estimates. Later additions could separate user work from coordinator side calls, show actually served models after routing, and compare periods where dated coverage is sufficient. Avoid forecasting allowance exhaustion from token totals: provider units and shared activity do not establish that conversion.

## Installed native metadata verification

On October 12, the owned [probe script](../../.zstack/usage-dashboard/provider-probe.cjs) inspected native version/help and opened one bounded stdio connection for each provider. The script has a transmitted-method allow-list and refused unexpected server requests. No `session/new`, `session/prompt`, `thread/start`, `turn/start`, account mutation, direct private endpoint or inference request occurred. Provider stdout/stderr were drained without logging or saving raw bodies; only validated types and support states were printed. Native credentials stayed with each CLI.

| Check | Verified sanitized result |
| --- | --- |
| Codex native version | 0.162.1 |
| Codex native help | `app-server --help` advertises schema generation |
| Codex initialization | App-server initialized; `account/read` reported ChatGPT kind, with refresh disabled |
| Codex quota method | `account/rateLimits/read` succeeded |
| Codex quota shapes | `rateLimits` object, `rateLimitsByLimitId` object containing one bucket; primary `usedPercent`, `windowDurationMins`, `resetsAt` are numbers; percent finite and reset a safe integer; secondary null; credits object; planType string |
| Grok native version and ACP | 1.0.50; ACP protocol 1; `cached_token` advertised and accepted; `agent --help` advertises `--no-leader` |
| Grok billing method | Exact wire `_x.ai/billing` succeeded without opening a session |
| Grok period | `config.currentPeriod` object; `type`, `start`, `end` strings; `end` parseable as a timestamp |
| Grok allowance/financial fields | `creditUsagePercent`, `monthlyLimit`, `used` and outer `subscriptionTier` absent; `onDemandUsed` and `prepaidBalance` objects; `isUnifiedBillingUser` boolean |

The missing Grok percentage is a material availability case: native billing support does not guarantee a percentage. This probe did not establish whether absence means an omitted proto3 zero, an account with no included allowance, or another provider state. Preserve unknown rather than inferring zero. The probe intentionally did not print actual percentages, reset dates, financial amounts, account identifiers or addresses, nor record account contents.

Started process IDs were Codex version/help/server 66876, 83036, 80864 and Grok version/help/server 81044, 74552, 73880. All exited or were terminated after the read; a subsequent PID check found zero still running and no children attached to either server PID. No leader was started. `account/usage/read`, quota-change events and other clients/accounts were not live-tested.

## Acceptance checks before claiming account coverage

1. Metadata-only native reads succeed or show unavailable on each supported installed CLI; no model prompt is sent.
2. Fraction-to-percent conversion, seconds-to-time conversion, optional windows and weekly/monthly legacy fallbacks have fixtures.
3. Expired/stale observations stay distinct from fresh zero usage; offline and signed-out hosts retain safe feedback.
4. Cache subsets and parent/child usage do not double count. Historical undated entries stay out of date buckets.
5. Account quotas are not added across duplicate host connections. Stable performs no held-feature collection.

Unresolved: Grok's omitted percentage semantics, older-client support, Codex account-summary support, Claude idle refresh, Devin structured session/account reads, cross-host account deduplication, and historic dated/model completeness. Those are concrete capability checks; this report does not claim they passed.

## October 14, 2026: local records, Claude's idle read and Grok's percentage

Checked on the Windows laptop with Claude Code 2.1.299, `@anthropic-ai/claude-agent-sdk` 0.3.270, Codex's app-server and Grok Build's ACP agent. Only key names, counts, instants and model names were printed. [ADR-0080](../adr/0080-usage-counts-every-clients-work-on-each-computer.md) records the decision these findings support.

**Claude idle refresh exists.** Claude Code answers a stream-json control request `{ subtype: 'get_usage', skip_behaviors: true }` on the same connection Sotto uses for `initialize` (`SDKControlGetUsageRequest`, `sdk.d.ts`; the SDK method is `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`). It sends no prompt; the CLI serves a recent snapshot or asks its own provider with its own sign-in. A metadata-only probe answered in 1.4 seconds: `rate_limits.five_hour` and `seven_day` as 0-100 `utilization` with ISO `resets_at`, `seven_day_opus` and `seven_day_sonnet` (null today), `model_scoped[]` and `extra_usage.is_enabled`. The body also carries plan, session cost and codename keys, which a reader must not keep. The passive `rate_limit_event` carries `utilization` only past a warning threshold, which is why five-hour limits read "not reported" before; there is no `claude usage` subcommand.

**Codex** answered `account/rateLimits/read` in 1.8 seconds. The checked account has a single bucket whose primary window is a week (`windowDurationMins` 10080), so a window must be named by its duration, not by primary or secondary.

**Grok's omitted percentage is real.** `_x.ai/billing` answered in 1.5 seconds with the current weekly period's start and end, zero on-demand and prepaid amounts, `isUnifiedBillingUser: true` and no `creditUsagePercent`. The reset is known; the share used is not reported.

**Claude Code's local records.** `~/.claude/projects/<project>/<session>.jsonl`, with subagent sessions under `<session>/subagents/`. An assistant line carries `timestamp`, `sessionId`, `isSidechain`, `requestId`, `message.id`, `message.model` and `message.usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` with its 5-minute and 1-hour split, `output_tokens`). Frames of one message repeat with growing output, so `message.id` with the largest output is the record. `<synthetic>` frames carry no usage. On the laptop 1,950 files held July 19 to October 14; 28,364 of Sotto's 28,393 undated ledger entries matched a dated line by `message.id`.

**Codex's local records.** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/`. `session_meta` names the `originator` (the app: `sotto`, `codex_exec`, `Codex Desktop`, `codex-tui`, `codex_vscode`, `t3code_desktop`, `Claude Code`), `thread_source`, `parent_thread_id`, `forked_from_id` and `subagent_history_start_ordinal`. `turn_context` names the model per turn. Newer files have `token_usage_record` with a global `response_id`; older ones only `event_msg/token_count` with cumulative and last usage. Forked and subagent rollouts begin with a copy of their parent's items, often without the parent's own `session_meta`: 121,395 cumulative readings appeared in more than one file. The copy ends at the first running total the source session never had; `subagent_history_start_ordinal` is not that boundary, since in every rollout checked it equalled the file's whole line count while the copy ended far sooner. A nested subagent can name the top thread as its parent while copying an intermediate subagent's history. Most sessions write no `user_message` event; `event_msg/task_started` marks each turn. 4,026 files held April 21 to October 14; 16,264 of Sotto's 16,265 undated ledger entries matched by recomputing Sotto's own key from `turn_id` and the cumulative totals.

**Grok Build and Devin** keep no token counts locally: Grok's `~/.grok/sessions/*/events.jsonl` carries turns and timings only, and Devin's `sessions.db` carries context size, not billing.

A full numeric pass over both clients' records on the laptop, about 19 GB, took about 170 seconds with a line prefilter; Sotto's own threads came to 11.3B tokens, their subagents 19.1B, and the same clients outside Sotto 26.8B.
