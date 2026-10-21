# Dictation runs the speech model the user chooses

## Status

Accepted October 19, 2026, by the owner's choices, and amended October 20, 2026, when the owner chose to convert Parakeet Ultra to Sotto's own format and offer it and Parakeet v2 as downloads on every platform (decisions 5 to 7). **Number provisional until merge:** 0094 is the next free number on this branch, where 0093 is Owl on Apple silicon Macs; recheck before merging (docs/agents/domain.md). Supersedes the parts of [ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md) that download the model on first run and have setup start the download; the rest of ADR-0071 stands, and its decisions 3 and 4 now cover each of Sotto's downloads. Amends [ADR-0063](0063-first-run-setup-covers-the-agents-and-ends-in-the-threads-tour.md)'s speech model step. Straight to stable: it is not an Owl feature (ADR-0072).

## Context

Since ADR-0071, Sotto downloads Parakeet v3, 670 MB, as soon as it starts, whether or not the user wants it. Some Mac users already have speech models on disk. Willow Voice, for one, keeps FluidAudio's Core ML Parakeet models in `~/Library/Application Support/FluidAudio/Models`, among them Parakeet Ultra, Moondream's post-trained v3. Sotto could not use them and downloaded its own copy anyway.

A spike on this Mac loaded three of those folders with FluidAudio's `AsrModels.loadLocal`: `parakeet-ultra`, `parakeet-tdt-0.6b-v3` and `parakeet-tdt-0.6b-v2`. It transcribed a 6-second clip in 0.05 s. The first load took about 14 s while macOS compiled the Core ML model; later loads took about 0.4 s. Two other folders there do not load: `parakeet-tdt-0.6b-v3-coreml` lacks its joint model, and `avalon-lite`'s vocabulary does not match.

Moondream publishes Parakeet Ultra only as weights in Hugging Face's layout (`model.safetensors`, CC-BY-4.0), with no NeMo or ONNX file. Its card reports it ahead of v3 on every benchmark group it shows, by the widest margin on the 25-language FLEURS set. NVIDIA's English-only Parakeet v2 is published by sherpa-onnx in the same 8-bit layout as v3.

## Decision

**1. Dictation's speech model is chosen, not assumed.** Nothing downloads until the user picks one of Sotto's models. The choice is the `speechModel` setting, written only by main. With no model chosen, the speech model's status is missing and dictation says no speech model is chosen yet. An install whose Parakeet v3 is already downloaded keeps it chosen, so existing users see no change.

**2. Setup's speech model step offers what is already on this computer first.** It is headed "Choose a speech model". It lists the models it found, with the first as the suggestion and **Use** beside each, then a **Download** for each of Sotto's models not here yet, with its size beside it. Entering the step downloads nothing. Continue is offered once a model is chosen and has not failed.

**3. Settings → Transcription has a "Speech model" picker.** It lists every model Sotto can run on this computer, then Sotto's models not downloaded yet, each with its size. Picking one switches dictation to it; picking one of Sotto's that is not downloaded starts its download, because the user asked for it. Below the picker Settings names the chosen model, its maker and its languages, and shows its status with Try again.

**4. On Apple silicon Macs, Sotto runs FluidAudio's Core ML Parakeet models where they already are.** It looks in `~/Library/Application Support/FluidAudio/Models` for Parakeet Ultra (Core ML) by Moondream, Parakeet v3 (Core ML) and Parakeet v2 (Core ML), and lists a folder only when every file it needs is there. A bundled Swift helper, `sotto-coreml-asr`, built on FluidAudio 0.17.7 (Apache-2.0), loads the chosen one and transcribes. It speaks a small protocol with main over stdin and stdout, version 1: samples in, one line of text out per segment. Its own and FluidAudio's log lines go to stderr, which Sotto ignores, and the transcript appears nowhere but the reply to main. Sotto only reads that folder. It never changes it and never downloads into it.

**5. Sotto offers three downloads on every platform: Parakeet v3, Parakeet Ultra and Parakeet v2.** Each is four files in sherpa-onnx's 8-bit layout, run by the same engine as v3, published on `millZach/Sotto-releases` under its own pre-release tag the updater never reads (`speech-model-parakeet-tdt-0.6b-v3-int8-1`, `speech-model-parakeet-ultra-int8-1`, `speech-model-parakeet-tdt-0.6b-v2-int8-1`), pinned by size and SHA-256 in `src/shared/speechModel.ts`, and downloaded into its own folder under `speech-models/`. Parakeet v2 is k2-fsa's export, unchanged. Parakeet Ultra is Sotto's own conversion, since nobody Sotto can rely on publishes one: Moondream's weights mapped onto NVIDIA's v3 NeMo model by renaming keys (the mapping reproduces NVIDIA's own v3 exactly), then exported and quantized with k2-fsa's v3 script. A community export exists; it was used only as a cross-check. The conversion and the transcripts that proved each model are in [the October 20 verification note](../verification/2026-10-20-sotto-speech-models.md).

**6. A Mac is not offered a download of a model FluidAudio already keeps here.** When FluidAudio's folder holds a model, the picker and setup leave out Sotto's download of the same model, so the user never fetches 650 MB of a model they have. If Sotto's copy is already downloaded, or is the current choice, both are listed; the Core ML copies carry "(Core ML)" in their names so the two never read the same.

**7. A download starts only on a deliberate choice.** Setup's buttons choose on a press. A closed list changes its value at every typed letter, and on Windows and Linux at every arrow key too, and fires a change each time, so the Settings picker takes those keys itself: they move to a model and say "Press Enter to download Parakeet Ultra, 671 MB, and switch dictation to it." Enter, or a click in the open list, chooses it. Escape or leaving the list goes back to the chosen model, and so does opening the list, so a click on the model moved to still chooses it. macOS opens its own menu on the arrows, where only Enter or a click chooses, so the Mac keeps its arrows.

## Considered options

- **Run only FluidAudio's copy of Parakeet Ultra.** What this ADR first decided: no conversion and no second download, but Ultra only on a Mac that another app had already given it, and nothing better than v3 on Windows or Linux. The owner chose to convert it so that every platform has it.
- **Ship the community sherpa-onnx export of Ultra.** Its graph and joiner match Sotto's conversion exactly and its transcripts nearly agree, but its provenance cannot be checked beyond its own description. Sotto's conversion is reproducible from Moondream's and NVIDIA's own files.
- **List only Sotto's models.** No native helper, but the model the user already has stays unused and Sotto downloads 670 MB beside it.
- **Keep downloading on first run.** What ADR-0071 did. The owner wants nothing downloaded that the user did not pick.

## Consequences

The Mac build carries a new runtime component: the `sotto-coreml-asr` binary. It is not an npm package, so the production dependencies stay exactly `zod`, `node-pty` and `sherpa-onnx-node`, and ADR-0018's rule is unchanged. The packaged-resources check and the notices must cover the helper and FluidAudio's licence. The helper is macOS-only and Apple silicon only.

The models in FluidAudio's folder belong to the app that put them there. If it deletes or moves them, Sotto's status says the model's files are no longer on this computer, nothing is lost, and the picker offers the rest. Sotto does not repair or re-download another app's models.

The first time a Core ML model loads, macOS takes about 14 s to compile it, and dictation says the model is loading until it is ready. Later loads take about 0.4 s.

Sotto now publishes a converted model, so it owes CC-BY-4.0's credit for it: NVIDIA and Moondream are named, with the licence and the changes made, in the notices and in the release's description. A new version of any of the three is new assets under a new tag and new pins; the assets under a tag are never replaced.

Each of Sotto's models costs about 0.7 GB of memory while it runs, and only the chosen one is loaded. Switching keeps the previous model's files, so switching back downloads nothing.

No new host is contacted. Audio still never leaves the computer. Each of Sotto's models still comes from Sotto's own releases on GitHub, checked as ADR-0071 says, but only once the user picks it.
