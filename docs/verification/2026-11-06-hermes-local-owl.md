# Hermes in the local Owl — November 6, 2026

Local branch `feat/hermes-local-owl-20261106`, based on `owl/council-combined-20261106` at `39384c6035a9b844be696b22dece6beff91501d3`. Council and Dynamic changes remain included. No push, PR, installation or Sotto launch.

Hermes is held behind its Owl feature and runs only on this Mac. One Sotto-owned gateway uses `<userData>/hermes`; project-path homes keep native memory and skills, with an ACP viewer per open thread. Only Full access is offered (`dont_ask`, approvals off). Unexpected permission requests use Sotto's existing card with allow-once/reject only. The native generic command field and complete permission binding remain limitations.

The pinned external client is `/Users/drakemorey/Developer/Tools/hermes-v0.23.0/.venv/bin/hermes`, upstream commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`, with ACP and MCP extras. No personal Hermes home, shell profile or launchd change. Config disables external-login adoption, fallback providers, title generation and update checks. Own-server routes are read from Sotto's record; there is no TensorFold-specific behavior. Refuseless uses the native `key_cmd` to capture the authorized Keychain item's value directly; keys are absent from configuration and Sotto logs.

## Checks

| Check | Result |
| --- | --- |
| Spark coding through the real adapter, including HTTP MCP | Pass: file written, Python assertion passed, native Sotto tool called; 20.9 seconds |
| Streamed text and reasoning | Pass: actual streamed thought and reply updates observed |
| Second project on the same gateway | Pass |
| Steering during a terminal command | Pass: final response changed to the steered answer |
| Cancel during a terminal command | Pass: interrupted in 0.17 seconds |
| Disconnect/reconnect and resume with HTTP MCP | Pass; combined steering/cancel/resume sequence 21.3 seconds |
| Refuseless Keychain-backed model selection | Pass after replacing inherited credential environment with native key command |
| Refuseless coding repeat | Blocked: Cloudflare HTTP 403 before generation; not an adapter coding pass |
| Refuseless directory / reasoning / title fixes | Directory pinned in config, process PWD and prompt; supported `high` reasoning default; native and Sotto title side calls disabled. Fresh end-to-end verification remains blocked by that 403 |
| Typecheck, lint and focused unit files | Pass; see local build terminal output |
| Packaged app | Built and inspected without launching; user installation and UI trial remain pending |

Queueing uses Sotto's existing queue. Native project memory and skills are enabled; the preceding plain Hermes probe demonstrated cross-session memory, but this adapter run did not repeat that test or measure long-lived memory use. No claim of UI or full adapter-contract verification.

## Known issues and scope

Hermes still writes prompt text to its own logs and fetches the models.dev catalog. Project memory can cross model routes when the user switches between Spark and Refuseless in one project.

Watcher, remote hosts, phones, Windows/Linux, other permission modes and all subscription sign-ins are excluded. Client updates are manual at the pinned path. No shipping claim.

A later PR needs the provider ADR and README/privacy/key-handling decisions, supported install/update design, Windows work and CI/adapter-contract coverage, plus a real UI trial. The user explicitly deferred that work for this local Owl.

After installing at a quiet time, connect Hermes in Providers, create a Full access Spark thread in a real project, ask it to edit and test a small file, steer it while running, queue a follow-up, stop a running command, and reopen the thread to resume. Try a second thread in the same project for memory, then Refuseless once its API permits traffic. Check the existing Council and Dynamic flows as well.
