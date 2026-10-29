# Speed is a thread setting

## Status

Accepted October 26, 2026, at Zach's request. It goes straight to stable and is not an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). The mock-up is `docs/prototypes/fast-mode-prototype.html` on the `prototype/composer-fast-mode` tag; Zach picked direction A. It adds a control to the option chips that [ADR-0113](0113-the-composer-controls-are-text-buttons.md) draws and changes none of the others.

Amended October 29, 2026, at Drake's request: Speed includes Fast and Ultra fast, and worker roles may choose it (ADR-0091).

## Context

Claude Code and Codex can each answer faster for more money. Claude Code calls it fast mode: up to 2.5x faster output at twice the price per token, on Opus 5.5, Opus 5 and Opus 4.8 as of 2.1.310 ([fast mode](https://code.claude.com/docs/en/fast-mode)). Codex calls it the Fast service tier, id `priority`, offered per model in `model/list` as of codex-cli 0.164.0 and described there in Codex's own words, such as "2x speed, increased usage". Some Codex models even list Fast as their own default tier, and a user's Codex config can set one too.

Sotto had no way to ask for either, so a thread ran at whatever speed the client's own defaults gave it, which Sotto could not show.

## Decision

**1. Speed is the user's choice, per thread.** Standard is the default. A thread may choose Fast or Ultra fast where its model offers them. It stays as the user leaves it. A worker started by role takes that role's speed unless the request names one; other new threads start at Standard.

**2. The thread keeps the choice, and the model decides whether it runs.** `AgentThread.speed` is `fast` or `ultrafast`, saved with the thread; absent means Standard. `fastMode: true` remains a compatibility alias for `fast` in saved threads, older hosts and phone clients. A named speed wins over the alias; Ultra fast never sets that alias. A change names `speed: null` to select Standard. A thread moved to a model without its chosen speed keeps the choice and runs at Standard; moved back, it uses that speed again, unless Claude Code refuses Fast (decision 4). Explicitly selecting a speed the model does not offer is refused. A fork or continued agent starts at Standard.

**3. Support is the provider's word.** `AgentModel.speeds` lists the offered speed IDs, names and descriptions. Claude Code offers only Fast when its catalog says `supportsFastMode`. Codex's `model/list.serviceTiers` maps `priority` to `fast` and `ultrafast` to `ultrafast`, keeping the provider's names and descriptions. `AgentModel.fastMode` remains present only for Fast, for older clients. Sotto keeps no model allow-list and reads no deprecated `additionalSpeedTiers`.

**4. Claude Code gets it as a flag layer.** Every launch carries `--settings '{"fastMode":true}'` where fast mode runs and `--settings '{"fastMode":false}'` everywhere else, which leaves the user's own saved settings alone. A `fastMode` the user saved with `/fast` would otherwise run a thread fast, and bill it so, while its bolt shows off, and would carry over when a live model change moves the thread onto a model with fast mode. On a running CLI it sends `apply_flag_settings` with `{ fastMode: true }` or `{ fastMode: false }`, the channel effort already uses. Off is `false` rather than none, so the flag layer outranks a `fastMode` in the user's own settings. Fast mode goes off before a model change and comes on after one, so the CLI never holds it on a model without it. A running CLI that refuses to turn fast mode on has the last word, and the CLI keeps running. A toggle it refuses changes nothing. A model change that carried the thread's choice onto a model with fast mode, refused only for fast mode, goes through: the thread is on the new model at normal speed, its choice is now off, and the user is told Claude Code did not switch fast mode on and which model the thread is on. That is the one place the choice changes without the toggle. Sotto does not start the CLI again with the flag, as it does for other settings a running CLI refuses, because that would only hide an account or organisation that does not allow fast mode.

**5. Codex gets it as the thread's service tier.** `thread/start`, `thread/resume` and `thread/fork` carry `serviceTier: "priority"` for Fast or `serviceTier: "ultrafast"` for Ultra fast where the chosen speed runs and `"default"` where the model offers a speed and the thread runs at Standard, so neither a model's own Fast default nor the user's Codex config makes a thread fast unasked. A model without the tier is left to Codex, and Codex's answer about the tier is checked only where Sotto named one. A change goes through `thread/settings/update`, which names `serviceTier` only when the model the change leaves the thread on offers a speed or the thread is leaving a model where a chosen speed ran; any other change leaves the tier alone, as before. Codex's `thread/settings/updated` notification confirms the exact named tier as it confirms a model, so Fast never confirms Ultra fast. Sotto does not set the tier per turn on `turn/start`: that would give the tier a second place to live, and only the thread-level path tells Sotto what Codex took.

**6. In both composers it is a bolt after the model chip.** A press cycles Standard → Fast → Ultra fast → Standard, skipping speeds the model does not offer. A model with Fast alone keeps the two-state press. It is 28px like its neighbours (ADR-0113): muted outline for Standard, filled in `--tt-accent-text` for Fast, and a distinct second bolt or small 2 for Ultra fast. `aria-pressed` says whether a speed is on; the accessible name names its state, and the tooltip keeps the provider's words. The quiet pill keeps only the glyph (ADR-0161). It is drawn only where a Claude Code or Codex model offers a speed, fixed with the other chips, with no confirmation or nag.

**7. It holds nothing back.** A speed change waiting on the provider's answer is a pending setting like a model or effort change: the thread still sends, and a later press replaces it (#1192). A refusal or a lost answer is said under the chips in the same way, in the speed's own words.

## Consequences

A thread with a faster speed selected costs more on the user's own Claude or Codex account. Nothing new is contacted: the request goes to the thread's own provider, and the README's Privacy and cost section says what it costs.

The remote command allow-list takes `speed` and the compatibility `fastMode` on `configure-thread`. It changes speed and price, as a model does, and answers no permission. The field is optional everywhere, so older hosts, the headless host and the phone clients keep working; an older host refuses a change that names it.

Codex threads now name their tier on a start, resume, fork or settings change only where the model offers a speed, or where a change takes the thread off a model it ran faster on. A user who had set Fast in their Codex config gets standard speed on those models in Sotto until they turn fast mode on for the thread. `"default"` was accepted by codex-cli 0.164.0; an older Codex that does not know it would refuse those requests, but not a change to a thread on a model without Fast, which names no tier.

Sotto does not read Claude Code's `fast_mode_state` (`on`, `cooldown`, `off`), so a thread whose fast mode is cooling down still shows the bolt filled. Nothing logs it with prompt text.
