# Dictation runs the speech model the user chooses

## Status

Accepted October 19, 2026, by the owner's choices. **Number provisional until merge:** 0094 is the next free number on this branch, where 0093 is Owl on Apple silicon Macs; recheck before merging (docs/agents/domain.md). Supersedes the parts of [ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md) that download the model on first run and have setup start the download; the rest of ADR-0071 stands. Amends [ADR-0063](0063-first-run-setup-covers-the-agents-and-ends-in-the-threads-tour.md)'s speech model step. Straight to stable: it is not an Owl feature (ADR-0072).

## Context

Since ADR-0071, Sotto downloads Parakeet v3, 670 MB, as soon as it starts, whether or not the user wants it. Some Mac users already have speech models on disk. Willow Voice, for one, keeps FluidAudio's Core ML Parakeet models in `~/Library/Application Support/FluidAudio/Models`, among them Parakeet Ultra, Moondream's post-trained v3. Sotto could not use them and downloaded its own copy anyway.

A spike on this Mac loaded three of those folders with FluidAudio's `AsrModels.loadLocal`: `parakeet-ultra`, `parakeet-tdt-0.6b-v3` and `parakeet-tdt-0.6b-v2`. It transcribed a 6-second clip in 0.05 s. The first load took about 14 s while macOS compiled the Core ML model; later loads took about 0.4 s. Two other folders there do not load: `parakeet-tdt-0.6b-v3-coreml` lacks its joint model, and `avalon-lite`'s vocabulary does not match.

## Decision

**1. Dictation's speech model is chosen, not assumed.** Nothing downloads until the user picks Sotto's Parakeet v3. The choice is the `speechModel` setting, written only by main. With no model chosen, the speech model's status is missing and dictation says no speech model is chosen yet. An install whose Parakeet v3 is already downloaded keeps it chosen, so existing users see no change.

**2. Setup's speech model step offers what is already on this computer first.** It is headed "Choose a speech model". It lists the models it found, with the first as the suggestion and **Use** beside each, then **Download Parakeet v3**, with its size (670 MB) beside it. Entering the step downloads nothing. Continue is offered once a model is chosen and has not failed.

**3. Settings → Transcription has a "Speech model" picker.** It lists every model Sotto can run on this computer, and Sotto's Parakeet v3 as a download when it is not there yet. Picking one switches dictation to it; picking Parakeet v3 when it is not downloaded starts the download, because the user asked for it. Below the picker Settings names the chosen model, its maker and its languages, and shows its status with Try again.

**4. On Apple silicon Macs, Sotto runs FluidAudio's Core ML Parakeet models where they already are.** It looks in `~/Library/Application Support/FluidAudio/Models` for Parakeet Ultra (Moondream, 25 European languages), Parakeet v3 (Core ML) and Parakeet v2 (English only), and lists a folder only when every file it needs is there. A bundled Swift helper, `sotto-coreml-asr`, built on FluidAudio 0.17.7 (Apache-2.0), loads the chosen one and transcribes. It speaks a small protocol with main over stdin and stdout, version 1: samples in, one line of text out per segment. Its own and FluidAudio's log lines go to stderr, which Sotto ignores, and the transcript appears nowhere but the reply to main. Sotto only reads that folder. It never changes it and never downloads into it.

**5. Windows and Linux show the same picker with Sotto's model only.** There is no helper there and no FluidAudio folder to read.

## Considered options

- **Convert Parakeet Ultra to Sotto's own format.** It would run on every platform through sherpa-onnx, but it is another 650 MB download, and the Mac user already has the model.
- **List only Sotto's models.** No native helper, but the model the user already has stays unused and Sotto downloads 670 MB beside it.
- **Keep downloading on first run.** What ADR-0071 did. The owner wants nothing downloaded that the user did not pick.

## Consequences

The Mac build carries a new runtime component: the `sotto-coreml-asr` binary. It is not an npm package, so the production dependencies stay exactly `zod`, `node-pty` and `sherpa-onnx-node`, and ADR-0018's rule is unchanged. The packaged-resources check and the notices must cover the helper and FluidAudio's licence. The helper is macOS-only and Apple silicon only.

The models in FluidAudio's folder belong to the app that put them there. If it deletes or moves them, Sotto's status says the model's files are no longer on this computer, nothing is lost, and the picker offers the rest. Sotto does not repair or re-download another app's models.

The first time a Core ML model loads, macOS takes about 14 s to compile it, and dictation says the model is loading until it is ready. Later loads take about 0.4 s.

No new host is contacted. Audio still never leaves the computer. Sotto's Parakeet v3 still comes from Sotto's own releases on GitHub, checked as ADR-0071 says, but only once the user picks it.
