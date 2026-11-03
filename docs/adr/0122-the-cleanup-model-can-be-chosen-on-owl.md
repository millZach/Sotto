# The cleanup model can be chosen on Owl

## Status

Accepted October 23, 2026, at Drake Morey's request, as an Owl feature (`cleanup-model`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). On Owl it supersedes decisions 5 and 6 of [ADR-0069](0069-one-model-does-ai-cleanup.md) and the line in its Consequences that a new cleanup model is never an option in Settings. Stable keeps ADR-0069 whole until Zach sends the feature. **Number provisional until merge** (docs/agents/domain.md).

He asked to choose the OpenRouter model that cleans up dictation, and the mode OpenRouter routes it in (Default, Nitro and so on), in Settings → Cleanup under the OpenRouter key, the way his YouTube summary extension does. He chose a live list with search, the modes Default, Nitro and Floor, and Mercury 2 kept as the backup.

## Context

ADR-0069 made AI cleanup one switch: the owner did not want people to think about models, so Settings named none and Claude Haiku 5.5 at low effort cleaned up every transcript. Someone who already pays OpenRouter and knows its models has no way to try another one, or to ask for the fastest or the cheapest host, without a code change.

## Decision

**1. Settings → Cleanup gains Cleanup model and Mode, under the OpenRouter key, on Owl only.** Cleanup model is a search box over OpenRouter's text models, with Default first. Default is ADR-0069's model and stays the default. Mode is Default, Nitro or Floor.

**2. The list is read when the box opens, never before.** Main asks `openrouter.ai/api/v1/models`, the host cleanup already uses, sends no key, and hands back each model's slug and name. Refresh reads it again. Nothing is kept between reads.

**3. A chosen model runs at low effort.** OpenRouter ignores the effort on a model that does not reason, and a model that must reason accepts it where turning reasoning off is refused. ADR-0069 chose low effort over thinking off for the same reason: thinking off cut transcripts short.

**4. The mode is a suffix on the first model only.** Nitro appends `:nitro` (hosts sorted by speed, priority endpoints allowed and billed at their rate), Floor `:floor` (hosts sorted by price, flex endpoints allowed). Default sends the slug as it is. It applies to Default's model too.

**5. Mercury 2 stays the backup, unsuffixed.** A chosen model that fails, runs long or no longer exists hands over to Mercury 2 as Haiku does, so dictation never waits on a choice. A user who chose Mercury 2 itself gets Haiku 5.5 as the backup, so a failure is never retried on the same model. When OpenRouter no longer lists the saved model, Settings says Mercury 2 is cleaning up instead.

**6. Off, nothing of it runs.** With the feature off, main never registers the list call, the cleanup pass ignores the saved model and mode, and Settings shows neither. The saved choice stays in settings, so turning the feature on restores it.

## Consequences

A chosen model sends the text to whichever host serves that model, under that host's terms, rather than Anthropic's or Inception's. The README says so. What a cleanup costs is now whatever the chosen model costs; the README's per-thousand figure is for Default.

Sotto has not measured any model but the two ADR-0069 benchmarked. A model that rewrites too much still meets the shrink guard in `cleanupOutput.ts` and falls back.

Changing Default is still a change to `CLEANUP_MODELS`, a benchmark run and an amendment to ADR-0069.

## Amended October 25, 2026: your own servers in the list

[ADR-0136](0136-ai-cleanup-can-run-on-your-own-model-server.md) adds a Your own servers section to the Cleanup model list, as its own Owl feature: the models of the user's own model servers added without a key, which main asks directly with the setting Measure found fastest. Mode does not apply to them, and Mercury 2 stays the backup, as decision 5 says.

## Amended October 31, 2026: OpenRouter presets

The cleanup list also offers the account's active OpenRouter presets, before the public models. On opening or refreshing the list, main asks `openrouter.ai/api/v1/presets` with the existing OpenRouter key. The public catalog still gets no key. The authenticated read follows no redirects and only the names and IDs reach the renderer. If the key cannot list presets or that read fails, the public catalog still works.

Cleanup model also accepts a pasted `@preset/<slug>` reference, chosen from the matching row or with Enter. A preset missing from the list is not called gone: some keys can use presets without listing them. Settings validates and preserves these IDs.

For presets, decisions 3 and 4 change: Sotto sends the reference unchanged and omits reasoning and provider overrides, leaving the saved preset in control of those settings. Mode is hidden while a preset is selected. The last ordinary model's mode stays saved for switching back. Sotto still supplies its cleanup prompt and output limit. Decision 5's Mercury 2 backup is unchanged, including when a preset pins its own provider.
