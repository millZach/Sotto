# Dictation can be transcribed by an OpenRouter speech model

## Status

Accepted October 29, 2026, by the owner's choices. An Owl feature (`cloud-dictation`, ADR-0072). **Number provisional until merge** (docs/agents/domain.md). Amends [ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md) decisions 1 and 8 on Owl, and [ADR-0069](0069-one-model-does-ai-cleanup.md)'s "the key is only for AI cleanup". Keeps [ADR-0055](0055-a-failed-dictation-is-kept-in-memory-until-tried-again-or-discarded.md)'s kept recording and its retry rules for rate limits.

Zach asked for a switch that turns off local dictation and sends it to any speech-to-text model on OpenRouter, the list ordered from best rated to worst, using the OpenRouter key AI cleanup already holds, or asking for one. He chose each of these when asked: rank by a blend of word error rate and speed, measured; the switch in Settings → Dictation's Speech model group, where that group is today; the ranked list (variant B of `docs/prototypes/cloud-dictation-prototype.html`, kept under the tag `prototype/cloud-dictation`); privacy wording in Settings and the docs only, not new words in the widget or Dictate; a failed dictation kept, with the local model offered for it when one is downloaded; the list read live from OpenRouter; zero-retention hosts used when a model has one; models without one kept and marked; the dictionary sent as spelling hints; the price in each model's tooltip; and Owl first.

## Context

ADR-0006 sent every dictation to MAI-Transcribe-2 through OpenRouter; ADR-0071 brought it back to this computer because MAI was slow and Azure turned requests away in bursts (ADR-0055). Since then OpenRouter has added a speech-to-text endpoint, `POST /api/v1/audio/transcriptions`, and lists 29 models whose output is a transcription (`GET /api/v1/models?output_modalities=transcription`, October 29, 2026). It takes base64 WAV as JSON, `keyterms` for spelling hints on models that take them (a 400 on those that do not), and `provider.zdr` to route only to hosts that keep no prompt. `GET /api/v1/endpoints/zdr` lists those hosts; 22 of the 29 models have one.

OpenRouter has no rating for these models. Its benchmarks API covers coding, intelligence, agentic work and search, and its usage datasets count tokens, which transcription does not use. Artificial Analysis's AA-WER v2 (English) scores 21 of the 29 but times 10-minute files, not dictation. Its price field is per second for most models and per hour for MAI, so it cannot be compared as given.

## Decision

**1. One switch, in Owl.** `cloudTranscription`, off by default, is the first row of Settings → Dictation's Speech model group: **Transcribe with OpenRouter**, "Sends your audio to the model you pick. Off, dictation is transcribed on this computer." In stable the switch does not exist and a saved value is kept and ignored (`cloudTranscriptionOn` in `src/shared/settings.ts`).

**2. On, OpenRouter transcribes every segment, and the speech model here is let go.** Main sends each segment as it is cut to the chosen model with the OpenRouter key AI cleanup uses, and unloads the local speech model once no segment is being transcribed with it, counted segment by segment, so turning the switch on mid-dictation never pulls the model from under one. Off, the model loads again. When the local engine runs in its own helper process, unloading it frees that process's memory. With dictation off (ADR-0107) neither runs.

**3. The key is shared, and asked for where it is needed.** With a key saved, the group says it uses that key. With none, the key field shows under the switch, and until one is saved a dictation records nothing and says where the key goes.

**4. The list is OpenRouter's, read live, ranked by Sotto's measurements.** Main reads the two public lists without the key, only when the group opens or a dictation needs them (for the default model and for zero retention), never at start or when the switch turns on, and keeps them ten minutes. Sotto ranks them by a blend: the share of words wrong on its test clips plus `SECONDS_WEIGH_AS_WER` for every second the text took to come back (`src/shared/cloudSpeechModels.ts`). The scores come from `scripts/asr-bench/bench-openrouter-stt.mjs`, run before each change to the table; a model Sotto has not measured falls back to Artificial Analysis's error rate, then to its name. The top five show, with **Show all**. Each row shows its error rate and time; its tooltip gives the price per hour where it is known and whether its host keeps audio. With nothing chosen, the first in the ranking is used.

**5. Zero retention where it exists.** A model with a host that keeps no audio is sent only to that host. When the list cannot say, because it could not be read or does not name the model, the request still asks for a zero-retention host, so audio never reaches a host that keeps it for want of a list. A model without one stays in the list, marked, and its tooltip says its host may keep the audio under its own terms.

**6. The dictionary goes as spelling hints.** Each request carries up to 200 dictionary words as `keyterms`. A model that refuses them is asked again at once without them and not offered them again until Sotto restarts.

**7. Failures keep the recording.** OpenRouter's answers map to new reasons (no key, key refused, out of credit, rate limited, OpenRouter not reached, model no longer offered), each with its own words on every surface. The rate-limit backoff ADR-0055 introduced for MAI comes back: waits of at least `Retry-After` and one, two and four seconds within the deadline. The recording is kept as ADR-0055 says, and Dictate also offers **Transcribe on this computer** when the chosen local model is already downloaded: it loads that model for this recording, then lets it go. Nothing falls back to this computer by itself, and the press never starts a download.

**8. Privacy wording lives in Settings and the docs.** The group's note says the audio goes through OpenRouter to the chosen model and is never saved on this computer. The widget gains nothing about the cloud, but while OpenRouter transcribes its processing tooltip drops "Transcribed on this computer" and says only "Audio is never saved" (the lesson of #655). Dictate and the footer say nothing about the local model while it is unloaded on purpose.

## Considered options

- **Rank by price, by Artificial Analysis alone, or by a short curated list.** Price says nothing about accuracy; AA times long files; a curated list misses new models. Zach chose a measured blend.
- **Fall back to this computer by itself.** It would load 0.7 GB without a press, and could not when no model is downloaded. Zach chose to offer it.
- **Say in the widget where the audio goes.** Zach chose Settings and the docs only.
- **Drop models without a zero-retention host.** Some of the best would go. Zach chose to keep and mark them.

## Consequences

On Owl, dictated audio can leave the computer again, to OpenRouter and the host behind the chosen model, under their terms and at the user's cost. No new host is contacted by Sotto: `openrouter.ai` is the one AI cleanup uses. The README, the guide and the glossary say so.

The diagnostics file records the model, reason, status, attempts and rate-limit source of a failed request, never the audio, the words or the key. History records an OpenRouter-transcribed dictation as `openrouter`.

Changing the ranking is a run of the bench, an update to `CLOUD_SPEECH_SCORES`, and an amendment here.
