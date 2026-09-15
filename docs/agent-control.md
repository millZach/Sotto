# Sotto agent control

Sotto creates and manages coding threads through the installed Codex, Claude Code and Grok Build clients. Threads have Sotto-owned identities; each native client keeps its own sign-in, model catalog and conversation history. All three providers can be connected together. Reading or sending a manual prompt does not grant Sotto permission to supervise a thread.

## Set up

1. Install and sign in to your chosen native coding client. Codex uses App Server, Claude Code uses stream-json and Grok Build uses ACP. Grok connection requires CLI 1.0.5 and ACP 1; incompatible versions produce an error before creating a session.
2. Open **Settings → Providers**. Select Codex, Claude Code or Grok Build in the list, then connect or enable it. Each row has its own status and switch; Configuration holds connection controls and a default model choice, while Models shows that provider's catalog. No server address or pairing token is needed.
3. In **New thread**, choose a model from any connected provider. That choice determines which client runs the thread. The same working folder can be used with different providers. Existing threads retain their provider; their model picker only offers models from that client. Unavailable models are reported rather than replaced.
4. Open **Settings → Agents**, directly below Providers, to configure the **Sotto coordinator** inline: its reasoning account, model and effort, plus the default projects directory. Native Codex, Claude and Grok subscriptions and explicitly configured OpenRouter and OpenAI API routes are supported. Changing this account does not change thread providers. Manual controls work without the coordinator.
5. Choose the speech route independently: **Grok voice** is the default and **Kokoro** is the cheaper option. Both use the configured hosted route; neither is a system voice. Save the relevant API key, select a voice and preview it. Sotto does not silently switch funding routes.
6. Configure compatible local wake-model and runtime directories before enabling voice. Wake detection runs locally. See the [wake verification record](verification/issue-9-wake.md) for model formats and distribution limits. Dictation remains available independently of agent control.

## Working with threads

The **Threads** page lists threads across providers. Create a thread with its project, model and available options; open one to read messages, type a prompt or answer an outstanding request. Native adapters recover threads created by Sotto; they do not import unrelated conversations from your coding clients.

Disconnecting one provider leaves other providers usable and keeps its thread identities, saved draft and assignments. Its thread controls wait until that provider reconnects. Turning off agent control stops coordination and voice control while leaving native thread connections available. Connecting a provider does not turn the coordinator back on.

A manual composer remains available when another thread owns a saved coordinator draft. You can prepare the next prompt while the current turn runs; sending waits for that turn to finish. A manual submission appears immediately with **Sending…**. It becomes a normal message only when delivery is confirmed. **Not confirmed** means Sotto has not established delivery; reconnecting or retrying reconciles the earlier action without automatically sending it twice. Per-thread composer drafts are saved locally with revision and delivery state for restart recovery. Recovery keeps the draft bound to its original thread and does not send it automatically.

Choose **Manage** to authorize supervision. **Pause managing** suspends automatic follow-ups. **Stop managing** removes the assignment without cancelling native work. Automatic follow-ups are limited to five by default and pause sooner on repeated failure without progress. New scope, human decisions, spending and permissions require the user's decision unless already authorized.

Questions and permissions enter the attention queue with their project and thread. **Next** and **Later** defer attention without answering. A composed answer stays bound to its question. Explicit **Allow** or **Deny** returns that decision to the native provider; skipping never approves. Unsupported interactive forms must be handled in the native client. Native hooks and permission settings still apply.

Sending directly through the same native provider session transfers that thread to manual control when its authored message is observed. Sotto continues monitoring and stops automatic replies. Reading or opening the native session is not takeover. Say “resume managing Workshop” or choose **Resume management** to authorize supervision again. Missing or locked native history can delay detection.

Model, effort, image and permission-mode controls reflect the adapter's verified capabilities. Unsupported controls are unavailable. Grok currently selects model and effort at thread creation and does not advertise image attachments or existing-thread configuration.

## Upgrading an older installation

An installation configured for the retired intermediary host is migrated before its saved state is interpreted as a native configuration. Sotto disables automatic connection, retains the draft and attachments without their old target, and preserves recovery evidence separately. Old assignments and uncertain actions are not transferred to a native provider or replayed. Existing thread bindings remain historical identities, never relabelled as native sessions.

The upgrade notice identifies the local recovery record. Check the original coding client before reusing a draft whose previous delivery was uncertain. A recovered answer is not permission to submit it to a new thread. Choose a native provider and explicitly prepare any new work. Installations already using a native provider keep their selection and recovery state.

## Data and accounts

Coding and reasoning usage belongs to the selected provider account. Sotto membership pays for coordination features and does not include model usage. Sotto never enables overages, buys credits or changes accounts automatically. Native clients retain subscription authentication; Sotto-owned API keys use the operating system's encrypted credential store. A locked vault reports an error without storing plaintext credentials.

Sotto stores thread bindings, assignment ownership, counters and dispatch identities locally. Assignment context expires after seven days without activity. **Keep local history** off suppresses supervision and clarification text. An unsent draft is the explicit exception: it remains local until sent or cleared. Recovery evidence follows the same history and expiry policy. Background audio and full native transcripts are not copied into coordinator state.

Coordinator actions append bounded turn records containing timings, acted-on thread/project IDs, retrieved memory IDs, context estimates and outcomes. Draft edits are not turns. With local history off, message and error text are blanked while timings and identities remain. Developer builds can reveal the turn-record folder from the tray menu. Voice timing reports identify measured software milestones separately from acoustic output.

## Development status

Every build without a configured membership service, installed or unpackaged, runs as private beta with agent actions available; that is not a paid entitlement. Production billing and deployment remain separate work. Native protocol evidence, automated tests and live checks are documented separately; a fixture test does not prove native compatibility or microphone performance.

See [native-host removal and current verification](verification/issue-24-closeout.md), [native adapter verification](verification/issues-17-22-23.md), [Claude protocol evidence](research/issue-22-claude-native-verification.md), [Grok protocol evidence](research/2026-09-11-issue-23-grok-acp-verification.md), and [Codex adapter decision](adr/0005-codex-app-server-adapter.md).
