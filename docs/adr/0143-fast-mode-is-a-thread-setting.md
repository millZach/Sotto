# Fast mode is a thread setting

## Status

Accepted October 26, 2026, at Zach's request. It goes straight to stable and is not an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). The mock-up is `docs/prototypes/fast-mode-prototype.html` on the `prototype/composer-fast-mode` tag; Zach picked direction A. It adds a control to the option chips that [ADR-0113](0113-the-composer-controls-are-text-buttons.md) draws and changes none of the others.

## Context

Claude Code and Codex can each answer faster for more money. Claude Code calls it fast mode: up to 2.5x faster output at twice the price per token, on Opus 5.5, Opus 5 and Opus 4.8 as of 2.1.310 ([fast mode](https://code.claude.com/docs/en/fast-mode)). Codex calls it the Fast service tier, id `priority`, offered per model in `model/list` as of codex-cli 0.164.0 and described there in Codex's own words, such as "2x speed, increased usage". Some Codex models even list Fast as their own default tier, and a user's Codex config can set one too.

Sotto had no way to ask for either, so a thread ran at whatever speed the client's own defaults gave it, which Sotto could not show.

## Decision

**1. Fast mode is the user's choice, per thread.** A new thread starts with it off. It stays on for that thread until the user turns it off. There is no app-wide default, and New thread does not offer it: the composer's chips already show before the first send, so it can be set there.

**2. The thread keeps the choice, and the model decides whether it runs.** `AgentThread.fastMode` is the choice, saved with the thread. A thread moved to a model without fast mode keeps it and runs at normal speed; moved back to one with it, it runs fast again. Turning it on for a model that does not offer it is refused. A thread that begins from another (a fork or a continued agent) starts with it off, like any new thread.

**3. Support is the provider's word.** A model offers fast mode when Claude Code's catalog says `supportsFastMode` for it, or when Codex's `model/list` lists a `priority` tier for it; `AgentModel.fastMode` is present only then, with Codex's description. Sotto keeps no list of its own, so a new Opus needs no change here. The deprecated `additionalSpeedTiers` is not read.

**4. Claude Code gets it as a flag layer.** At launch Sotto adds `--settings '{"fastMode":true}'`, which leaves the user's own saved settings alone. On a running CLI it sends `apply_flag_settings` with `{ fastMode: true }` or `{ fastMode: false }`, the channel effort already uses. Off is `false` rather than none, so the flag layer outranks a `fastMode` in the user's own settings. Fast mode goes off before a model change and comes on after one, so the CLI never holds it on a model without it. A running CLI that refuses to turn fast mode on has the last word: whatever the change had already moved, such as the model, is put back, the CLI keeps running, and the user is told Claude Code did not switch fast mode on. Sotto does not start the CLI again with the flag, as it does for other settings a running CLI refuses, because that would only hide an account or organisation that does not allow fast mode.

**5. Codex gets it as the thread's service tier.** `thread/start`, `thread/resume` and `thread/fork` carry `serviceTier: "priority"` where fast mode runs and `"default"` where the model offers it and the thread has it off, so neither a model's own Fast default nor the user's Codex config makes a thread fast unasked. A model without the tier is left to Codex, and Codex's answer about the tier is checked only where Sotto named one. A change goes through `thread/settings/update`, which names `serviceTier` only when the model the change leaves the thread on offers Fast or the thread is leaving a model where fast mode ran; any other change leaves the tier alone, as before. Codex's `thread/settings/updated` notification confirms a named tier as it confirms a model. Sotto does not set the tier per turn on `turn/start`: that would give the tier a second place to live, and only the thread-level path tells Sotto what Codex took.

**6. In the composer it is a bolt after the model chip.** A one-press text button, 28px like its neighbours (ADR-0113), with lucide's `Zap`: a muted outline while off, filled in `--tt-accent-text` while on, with `aria-pressed`. Its accessible name is "Fast mode", and its tooltip says once what it costs: Sotto's sentence for Claude Code, Codex's own description for Codex. It is drawn only for a Claude Code or Codex model that offers fast mode; for any other provider the row is unchanged. It is fixed when the other chips are. There is no warning, no confirm and no nag.

**7. It holds nothing back.** A fast mode change waiting on the provider's answer is a pending setting like a model or effort change: the thread still sends, and a later press replaces it (#1192). A refusal or a lost answer is said under the chips in the same way, in fast mode's own words.

## Consequences

A thread with fast mode on costs more on the user's own Claude or Codex account. Nothing new is contacted: the request goes to the thread's own provider, and the README's Privacy and cost section says what it costs.

The remote command allow-list takes `fastMode` on `configure-thread`. It changes speed and price, as a model does, and answers no permission. The field is optional everywhere, so older hosts, the headless host and the phone clients keep working; an older host refuses a change that names it.

Codex threads now name their tier on a start, resume, fork or settings change only where the model offers Fast, or where a change takes the thread off a model it ran fast on. A user who had set Fast in their Codex config gets standard speed on those models in Sotto until they turn fast mode on for the thread. `"default"` was accepted by codex-cli 0.164.0; an older Codex that does not know it would refuse those requests, but not a change to a thread on a model without Fast, which names no tier.

Sotto does not read Claude Code's `fast_mode_state` (`on`, `cooldown`, `off`), so a thread whose fast mode is cooling down still shows the bolt filled. Nothing logs it with prompt text.
