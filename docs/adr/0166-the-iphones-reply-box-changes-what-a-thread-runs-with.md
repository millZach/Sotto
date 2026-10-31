# The iPhone's reply box changes what a thread runs with

## Status

Accepted October 30, 2026, at Zach's request (#1922). It goes straight to stable and is not an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Zach picked direction B, "Chips in the box", from `docs/prototypes/iphone-thread-settings-prototype.html`. The research behind the three directions is `docs/research/2026-10-30-iphone-composer-thread-settings.md`.

## Context

The iPhone set a thread's model, effort and permissions only on New thread. Once the thread ran, its reply box changed none of them, and speed not at all, while the desktop's composer changes all four from its option chips ([ADR-0113](0113-the-composer-controls-are-text-buttons.md), [ADR-0143](0143-fast-mode-is-a-thread-setting.md), [ADR-0161](0161-the-quiet-composer-is-one-pill.md)). Zach asked for the iPhone's composer to change the model and effort, with Claude Code, Codex and T3 Code as the references, and confirmed it should cover everything a thread runs with: model, effort, speed and permissions.

The references put these in three ways. T3 Code's iPhone app has one chip that opens a Thread settings sheet holding all of them. Claude Code's desktop and web, and T3 Code's web app, have a chip for each under the prompt. Codex has one control for model, reasoning and speed, and permissions apart. The prototype drew one direction from each: A, one chip and one sheet; B, chips in the box; C, the desktop's split chip and shield.

The computer already took everything this needs. `configure-thread`, with `modelId`, `reasoningEffort`, `runtimeMode`, `providerMode`, `fastMode` and `speed`, has been on the remote allow-list since the desktop's own paired clients needed it, and a mode that lets a thread act without asking already needs the client's remote-answer policy (`remoteCommandNeedsAnswerPolicy`). Thread rows already carried the settings, the catalog each model's speeds, and the shell the changes a provider never confirmed.

## Decision

**1. The chips are the reply box's second line.** Under the words, inside the box: the model with its provider's logo, the effort in words, the speed bolt where the model offers more than Standard, and, at the line's end, the permissions shield. Each is a text button as on the desktop (ADR-0113), drawn 32 points tall and pressed across 44. The model and effort open an iOS menu, each effort level with its line about what it costs; the shield opens one with each permission mode and what the thread does under it. The bolt steps through the speeds on a press, an outline at Standard, one bolt at Fast and two at Ultra fast, told by shape. The shield is an outline while the thread asks before acting, half filled while it may act without asking, and filled for Full access. At the accessibility text sizes the model takes a line of its own above the others.

**2. It sends the desktop's change and follows the desktop's rules.** A press sends `configure-thread` with the one field it changes, the speed by name or, to a computer whose catalog names no speeds, as `fastMode`. What a press shows until the agent answers follows `pendingSettings.ts`: the press shows at once; one made while a save of the same setting is on its way waits, and only the newest goes; a permission change is a pending setting, marked on the shield with a line over the box saying what is still in force; a refusal puts the chip back and says why, with Try again; a change the agent never confirmed keeps its choice until the thread shows it or the computer lets it go. A change is never sent again on its own. What became of it is read from the thread the computer answers with, since the shell's error is shared.

**3. Only the thread's own provider's models.** The model menu lists that provider's ready models, as the desktop's does once a thread has started (#1601). Carrying on with another provider is a new thread, which the desktop begins ([ADR-0089](0089-a-thread-continues-on-another-provider-as-a-new-linked-thread.md)); the phone does not begin one.

**4. The chips wait when the agent would refuse.** As on the desktop, they are held while a turn runs or a prompt is still on its way to start one, while a request waits on the user, for an archived thread, while the computer or the agent cannot be reached, and while a permission change goes unconfirmed. Each chip's VoiceOver hint then says until when. Where the provider changes only a started thread's permissions (`configureThreadModel: false`), the model and effort are held and the shield is not. A computer that does not say it changes a thread's settings in place (`configureThread`) gets no chips.

**5. A grant is still the user's, and the computer's to check.** A mode that lets the thread act without asking can be chosen only where this iPhone may answer on that computer, as on New thread, and the computer checks the same policy again when the change arrives (ADR-0004). Choosing a mode is the user's own press, never something the phone does for them.

## Consequences

- The iPhone builds `configure-thread`, which it never did before. `RemoteCommands` lists it with the host's fields, and `Commands.configureThread` refuses anything else before it is sent.
- A model change the agent takes without the speed the thread had chosen says so on the bolt's line, as the desktop's `SPEED_NOT_CARRIED` does. Pressing the base model a thread already runs as its long-context variant leaves the thread on the variant.
- Not ported: favorites are this computer's window's own (ADR-0147) and the phone has none. The draft's suggested effort (ADR-0161 decision 3) and Claude Code's `ultrathink` are desktop only.
- The chips make the box one short line taller wherever a thread's computer offers them. The conversation makes room for it as it does for photos.
- The Focus journey `testAThreadsSettingsChangeFromItsReplyBox` (`--ui-thread-settings`) changes each setting on the simulator and keeps `thread-settings-*` captures in dark and light. CI runs it on the iPhone SE and the iPhone 16 Pro Max; the iPhone Duo is not among CI's simulators.
