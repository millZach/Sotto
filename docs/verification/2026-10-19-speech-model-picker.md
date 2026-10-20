# Dictation runs the speech model the user chooses (ADR-0094)

Proved in the built app on October 19, 2026, on an Apple silicon Mac (macOS 27), from `main` at `f05fa6b25` with this branch on top (`npm run build`, then Playwright driving `out/main/index.js` on a throwaway profile, `--user-data-dir`). This Mac has FluidAudio's models in `~/Library/Application Support/FluidAudio/Models`, put there by Willow Voice. The images named here are in `artifacts/speech-model-picker/`.

## What changed

Dictation no longer downloads Parakeet v3 by itself. Setup's speech model step looks for the models Sotto can run on this computer and offers them first, with downloading Parakeet v3 as the other choice; Settings → Transcription gains a Speech model picker. On an Apple silicon Mac those models include the Core ML Parakeet models FluidAudio keeps, which Sotto runs through its helper `sotto-coreml-asr`.

## What was checked

- `setup-1280x800-dark.png` and `setup-1280x800-light.png`: **Choose a speech model** lists **Parakeet Ultra, by Moondream**, **Parakeet v3 (Core ML), by NVIDIA** and **Parakeet v2, by NVIDIA** (English only) under "Already on this computer", then **Parakeet v3, by NVIDIA** with "670 MB, from GitHub." and **Download Parakeet v3**. Entering the step downloaded nothing. After **Use Parakeet Ultra** the row is marked chosen, its button stays (pressed, with a check) so focus stays on it, and the row reads "25 European languages. Ready." **Continue** replaces **Skip for now**. The two folders FluidAudio's loader cannot open (`parakeet-tdt-0.6b-v3-coreml`, `avalon-lite`) are not offered.
- `setup-820x560-dark.png`: the same four rows at the minimum window, with nothing scrolling. A script measured the card body at 820x560 and 1080x720 with all four rows and found no element whose content overflowed.
- `settings-transcription-1280x800-dark.png`: after quitting and starting again, Settings → Transcription shows **Speech model** set to Parakeet Ultra, the statement "Speech recognition by Moondream, on this computer. 25 European languages.", **Ready.** and "632 MB on this computer." The list offers Parakeet v3 (download, 670 MB), Parakeet Ultra, Parakeet v3 (Core ML) and Parakeet v2.

The helper was also run on its own and through `src/main/asr/coreMlEngine.ts`, on a spoken 6-second clip, against each model folder: all three transcribed it ("Hello Zach, this is a quick test of Parakeet Ultra…"; v2, English only, wrote "Zack"). Once macOS had compiled a model, a load took under half a second and a clip under a quarter of a second. The first load of a model on this computer took 14 to 46 seconds while macOS compiled it. After the helper turned FluidAudio's logging down to faults, `log show --predicate 'subsystem == "com.fluidinference" OR process == "sotto-coreml-asr"'` over a run of all three models returned nothing.

`npm run package:dir:mac` passed end to end: the app carries `Contents/Resources/coreml-asr/sotto-coreml-asr`, ad-hoc signed, and the packaged-resources check ran it with `--version`.

## Not checked here

Windows and Linux in the running app; there the picker offers only Parakeet v3, which the unit tests cover. The committed design-capture baselines for the speech model step and Settings → Transcription change on purpose and were not regenerated on this Mac, whose renders already differ from them on `main`.
