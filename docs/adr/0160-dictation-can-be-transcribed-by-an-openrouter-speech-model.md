# Dictation can be transcribed by an OpenRouter speech model

## Status

Accepted October 29, 2026, by the owner's choices. An Owl feature (`cloud-dictation`, ADR-0072). **Number provisional until merge** (docs/agents/domain.md). Amends [ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md) decisions 1 and 8 on Owl, and [ADR-0069](0069-one-model-does-ai-cleanup.md)'s "the key is only for AI cleanup". Keeps [ADR-0055](0055-a-failed-dictation-is-kept-in-memory-until-tried-again-or-discarded.md)'s kept recording and its retry rules for rate limits.

Zach asked for a switch that turns off local dictation and sends it to any speech-to-text model on OpenRouter, the list ordered from best rated to worst, using the OpenRouter key AI cleanup already holds, or asking for one. He chose each of these when asked: rank by a blend of word error rate and speed, measured; the switch in Settings → Dictation's Speech model group, where that group is today; the ranked list (variant B of `docs/prototypes/cloud-dictation-prototype.html`, kept under the tag `prototype/cloud-dictation`); privacy wording in Settings and the docs only, not new words in the widget or Dictate; a failed dictation kept, with the local model offered for it when one is downloaded; the list read live from OpenRouter; zero-retention hosts used when a model has one; models without one kept and marked; the dictionary sent as spelling hints; the price in each model's tooltip; and Owl first. From the measured table he chose one second of waiting to count as one point of words wrong, and, after the first-ranked model's only host went silent in a live check, MAI-Transcribe-2 as the model dictation uses until one is picked.

## Context

ADR-0006 sent every dictation to MAI-Transcribe-2 through OpenRouter; ADR-0071 brought it back to this computer because MAI was slow and Azure turned requests away in bursts (ADR-0055). Since then OpenRouter has added a speech-to-text endpoint, `POST /api/v1/audio/transcriptions`, and lists 29 models whose output is a transcription (`GET /api/v1/models?output_modalities=transcription`, October 29, 2026). It takes base64 WAV as JSON, `keyterms` for spelling hints on models that take them (a 400 on those that do not), and `provider.zdr` to route only to hosts that keep no prompt. `GET /api/v1/endpoints/zdr` lists those hosts; 22 of the 29 models have one.

OpenRouter has no rating for these models. Its benchmarks API covers coding, intelligence, agentic work and search, and its usage datasets count tokens, which transcription does not use. Artificial Analysis's AA-WER v2 (English) scores 21 of the 29 but times 10-minute files, not dictation. Its price field is per second for most models and per hour for MAI, so it cannot be compared as given.

## Decision

**1. One switch, in Owl.** `cloudTranscription`, off by default, is the first row of Settings → Dictation's Speech model group: **Transcribe with OpenRouter**, "Sends your audio to the model you pick. Off, dictation is transcribed on this computer." In stable the switch does not exist and a saved value is kept and ignored (`cloudTranscriptionOn` in `src/shared/settings.ts`).

**2. On, OpenRouter transcribes every segment, and the speech model here is let go.** Main sends each segment as it is cut to the chosen model with the OpenRouter key AI cleanup uses, and unloads the local speech model once no segment is being transcribed with it, counted segment by segment, so turning the switch on mid-dictation never pulls the model from under one. Off, the model loads again. Parakeet runs in its own helper process (PR #1795), so unloading it ends that process and frees its memory. With dictation off (ADR-0107) neither runs.

**3. The key is shared, and asked for where it is needed.** With a key saved, the group says it uses that key. With none, the key field shows under the switch, and until one is saved a dictation records nothing and says where the key goes.

**4. The list is OpenRouter's, read live, ranked by Sotto's measurements.** Main reads the two public lists without the key, only when the group opens or a dictation needs them (for the default model and for zero retention), never at start or when the switch turns on, and keeps them ten minutes. Sotto ranks them by the share of words wrong on its English clips plus one point for every second the text took to come back (`SECONDS_WEIGH_AS_WER = 0.01`). The scores are `CLOUD_SPEECH_SCORES` in `src/shared/cloudSpeechModels.ts`, measured with `scripts/asr-bench/bench-openrouter-stt.mjs` ([October 29 run](../perf/2026-10-29-openrouter-speech-models.md)); a model OpenRouter adds later is listed after them, by name, as not tested yet. The top five show, with **Show all**. Each row shows its error rate and time; its tooltip gives the price per hour Sotto was billed, or OpenRouter's where it is plainly per second, and whether its host keeps audio. With nothing picked, dictation uses MAI-Transcribe-2 while OpenRouter lists it, and the first in the ranking otherwise (`DEFAULT_CLOUD_SPEECH_MODEL`): Qwen3-ASR 1.7B ranked first, but its only host answered none of ten requests an hour later.

**5. Zero retention where it exists.** A model with a host that keeps no audio is sent only to that host. When the list cannot say, because it could not be read, does not name the model, or is over ten minutes old and says the model has none (a model can gain one), the request still asks for a zero-retention host, so audio never reaches a host that keeps it for want of a list. A model without one stays in the list, marked, and its tooltip says its host may keep the audio under its own terms. A model OpenRouter lists with a zero-retention host whose transcription route then refuses that routing (`mistralai/voxtral-mini-transcribe`, measured October 29) is listed and sent as one without.

**6. The dictionary goes as the spelling hints a model takes.** OpenRouter's `keyterms` field was refused by every transcription model on October 29; MAI-Transcribe-2 took the dictionary as Azure's phrase list (`provider.options.azure.phraseList`, the route ADR-0006 used) and with it spelled every name on the clips right. So MAI gets up to 200 dictionary words as its phrase list, the other measured models get none, and a model Sotto has not measured is offered `keyterms`, asked again at once without them if it refuses, and not offered them again until Sotto restarts.

**7. Failures keep the recording.** OpenRouter's answers map to new reasons (no key, key refused, out of credit, rate limited, OpenRouter not reached, model no longer offered), each with its own words on every surface. The rate-limit backoff ADR-0055 introduced for MAI comes back: waits of at least `Retry-After` and one, two and four seconds within the deadline. The recording is kept as ADR-0055 says, and Dictate also offers **Transcribe on this computer** when the chosen local model is already downloaded: it loads that model for this recording, then lets it go. Nothing falls back to this computer by itself, and the press never starts a download.

**8. Privacy wording lives in Settings and the docs.** The group's note says the audio goes through OpenRouter to the chosen model and is never saved on this computer. The widget gains nothing about the cloud, but while OpenRouter transcribes its processing tooltip drops "Transcribed on this computer" and says only "Audio is never saved" (the lesson of #655). Dictate and the footer say nothing about the local model while it is unloaded on purpose.

## Considered options

- **Rank by price, by Artificial Analysis alone, or by a short curated list.** Price says nothing about accuracy; AA times long files; a curated list misses new models. Zach chose a measured blend.
- **Use the top of the ranking until a model is picked.** Zach's first choice. In the live check after the run, that model's only host answered nothing for minutes while OpenRouter called it up, so everyone who had not picked a model would have lost every dictation to Try again. MAI-Transcribe-2 takes the dictionary and runs on Azure.
- **Fall back to this computer by itself.** It would load 0.7 GB without a press, and could not when no model is downloaded. Zach chose to offer it.
- **Say in the widget where the audio goes.** Zach chose Settings and the docs only.
- **Drop models without a zero-retention host.** Some of the best would go. Zach chose to keep and mark them.

## Consequences

On Owl, dictated audio can leave the computer again, to OpenRouter and the host behind the chosen model, under their terms and at the user's cost. No new host is contacted by Sotto: `openrouter.ai` is the one AI cleanup uses. The README, the guide and the glossary say so.

The diagnostics file records the model, reason, status, attempts and rate-limit source of a failed request, never the audio, the words or the key. History records an OpenRouter-transcribed dictation as `openrouter`.

Changing the ranking is a run of the bench, an update to `CLOUD_SPEECH_SCORES`, and an amendment here.
