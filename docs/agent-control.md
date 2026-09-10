# Sotto agent control center

Sotto controls the agent apps you already use from a desktop voice interface. This development version connects to local T3 Code 0.0.38. Its projects, messages, questions and permissions belong to the same threads visible in T3. Additional harnesses and phone integrations are outside this version.

## Set up

1. Start the supported T3 desktop app and configure your coding provider accounts there. Sotto discovers the models that account actually makes available; an unavailable model is reported rather than replaced.
2. Open Sotto → Agents → Connection settings. Keep the local T3 address or enter its loopback address. Connect T3 Code uses a separate local pairing session; a manually supplied T3 access token can also be saved securely.
3. Select a default agent model and a default projects directory. A project command may specify a full folder path instead. Existing folders require the explicit “Use this folder if it already exists” choice.
4. Configure compatible local wake-model and runtime directories before enabling voice. Development builds can use the pinned development runtime. Neither wake weights nor the general Sherpa runtime are bundled or automatically downloaded by the application. See the [wake verification record](verification/issue-9-wake.md) for the tested formats and unresolved distribution requirements. Sotto reports setup errors before opening the microphone.
5. For natural-language project/thread commands and automatic directional answers or fixes, select **Sotto reasoning**. Choose your **ChatGPT subscription through Codex**, **Claude subscription through Claude Code**, or **Grok subscription through Grok Build**, then check the connection. Sotto loads the installed client's complete available model list. Choose a model and one of its supported **Reasoning effort** levels, or retain the provider default, then save. Sign into the provider’s own installed client first; Sotto never asks you to paste its login tokens. Explicit OpenRouter and OpenAI API accounts remain available as alternatives. Manual controls, prompt dictation, and local control phrases also work without reasoning.

6. Choose **Speech voice → Natural voice · on this computer** for local Supertonic speech. Select **Download natural voices** once (263 MB), choose one of ten English voices, then **Use and preview voice**. This saves the voice without changing your reasoning model. The model terms are available beside the download. The operating system voice remains an optional alternative.

Local wake detection, speech recognition and natural speech stay on the computer, including when optional remote dictation is configured elsewhere. Speech voice is independent of the subscription reasoning model. Muting stops capture and still permits a voice preview. Shortcut dictation takes the microphone until it finishes. The mute, stop-speech and retry controls are also available without speech.

## Use it

Search the project sidebar by project or thread name. Select a project and create a thread with the default model or an explicit available override. A newly created thread is selected with an empty draft ready for its prompt. Select **Manage** to assign an existing thread. A thread is monitored only after assignment; selecting an existing thread does not authorize automatic replies.

Say **“Hey Soto” / “Hey Sotto”**, then “start prompt.” A short cue acknowledges activation without interrupting capture, so your command can follow immediately. Bare “Soto” is not currently a supported wake phrase. Dictate in several parts, pause to think, or edit the text. The draft remains attached to its original thread. Say “send it” or select **Send it** to submit. “Clear draft” discards it. “Stop listening” returns to wake monitoring and preserves the draft. A running thread keeps the draft until the agent finishes or you explicitly stop it.

Natural project and thread creation commands use the configured reasoning provider. If Sotto needs clarification, it retains the original command and your reply until resolved or cleared. When a prompt needs a thread, reply with the thread name or “select Workshop”; the original prompt becomes an editable draft on that thread. It still requires **Send it**, and an existing unassigned thread requires **Manage** before submission. Local control phrases include “select Workshop,” “manage Workshop,” “pause managing Workshop,” and “resume managing Workshop.” Duplicate thread names require choosing the intended thread in the UI.

The queue names the project and thread needing attention. Speak or type into **Your answer** to compose one editable draft bound to that question. Pauses do not send it; say **send it** or select **Send it** when finished. The question binding survives a restart, and edits synchronize between the main window and widget. Say **Next** or **Later** to move on before composing, or send/clear a draft first. Selecting another thread preserves the draft and shows **Return to draft thread**. Skipping a permission never approves it. Say **allow** or **deny**, or use its explicit approval controls. Sotto does not override T3’s own permission system.

**Sending directly in T3 puts only that thread into manual control.** Sotto keeps watching it, but stops automatic replies. Reading, selecting, or opening a thread does not transfer control. The widget and Agents view explain this handoff. Say “resume managing Workshop” or select **Resume management** to give it back. **Stop managing** removes the assignment and pending Sotto queue items; it does not stop work already running in T3.

Automatic follow-ups are limited to five by default. Sotto stops earlier when the same failure repeats without progress. Resume management explicitly authorizes another bounded set. Scope changes, human decisions, spending and host permissions remain human questions. A Sotto membership lapse prevents new Sotto actions while existing T3 work continues.

## Data, accounts and recovery

T3 coding usage belongs to the provider subscription or API account configured in T3. Sotto reasoning uses the subscription or API account selected in Sotto. A subscription may fund both roles through its supported native clients. Usage follows that provider’s allowance and any extra usage the user already enabled there; Sotto never enables overages, buys credits, or switches to another account automatically. Native local speech has no provider usage charge. Sotto membership pays for control-center features and does not include coding or reasoning usage.

The native subscription clients retain authentication and refresh their own logins. Sotto checks the actual account before requesting a decision, isolates the reasoning session, disables or denies actions in that session, and validates the returned decision before its controller can act. Missing clients, unavailable models, expired sign-ins, and usage errors stay on the selected route and produce a visible error. Changing a reasoning route clears the previous Sotto reasoning API key; it does not change logins in the provider apps.

Model and effort choices come from each provider's native catalog and follow the signed-in account's access. Changing models resets effort to the provider default. An explicitly chosen model or effort is never silently replaced with another. See the [model-selection QA record](verification/subscription-model-selection-qa.md) for native-client and desktop verification.

The native process encrypts T3, reasoning, membership and formatting credentials using the OS credential store. It migrates an existing formatting key out of settings after the vault accepts it. A locked vault reports an error; it does not save a new plaintext fallback.

Sotto persists assignment IDs, ownership, counters and dispatch IDs for recovery. It stores bounded assignment context for up to seven days without activity. Turning off **Keep local history** prevents saving supervision text or clarification context. An **unsent draft is the explicit exception**: it remains local until sent or cleared so a restart cannot lose work. Background audio and full host conversations are not saved by agent control.

If a host acknowledgement is lost, Sotto checks the existing action against host state and does not automatically send it again. A definite rejection leaves the draft available for correction. An unresolved action stays blocked until the host can confirm its state. Restarting or reconnecting never silently changes a manually controlled assignment back to managed.

## Development and release status

Run `npm run dev` for the private development beta. A packaged build without a configured membership service allows free dictation only. The membership client and service contract exist, but production identity, product pricing, webhook processing and billing deployment remain work for paid launch. No live subscription purchase is part of this implementation.

The [verification record](verification/issue-9-implementation.md) distinguishes automated Electron tests, live T3 checks, synthetic voice proof, and the real desktop checks still required. Do not describe the current build as a completed paid release.
