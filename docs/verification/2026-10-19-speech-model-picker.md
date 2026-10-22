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

## Windows, with Sotto's three downloads (October 20)

Proved on the Windows laptop (Windows 11) on October 20, 2026, with this branch's second change on top: Parakeet Ultra and Parakeet v2 as downloads on every platform, and the Settings picker's keyboard fix (ADR-0094, decisions 5 to 7). It was the built app (`npm run build`, then Playwright driving `out/main/index.js`) with no E2E switch set, so the download came from the published release assets and the speech engine was the real one. Each run used a throwaway profile, `--user-data-dir` under the Temp folder rather than `%APPDATA%`, so that the legacy-profile migration could not touch the real one. No microphone was used: the clips went through `window.sotto.transcribe`, the same IPC every dictation segment goes through, as 16 kHz WAVs in the recorder's 44-byte layout. The answers are in `artifacts/speech-model-picker/windows-prove-it.json`.

- `windows-setup-1280x800-dark.png`, `windows-setup-820x560-dark.png`: on a fresh profile, **Choose a speech model** offers **Download Parakeet v3** (25 European languages, 670 MB), **Download Parakeet Ultra** (25 European languages, 671 MB) and **Download Parakeet v2** (English only, 661 MB), all from GitHub. Nothing scrolls at 820x560, and entering the step created no `speech-models` folder.
- `windows-settings-arrowed-to-ultra-1280x800-dark.png`, `-820x560-dark.png` and `-1280x800-light.png`: on a fresh profile with nothing chosen, two presses of the down arrow in the closed **Speech model** list move it to **Parakeet Ultra, 671 MB**. The line above it then reads "Press Enter to download Parakeet Ultra, 671 MB, and switch dictation to it." After a second and a half the status was still missing, the setting was still empty and no `speech-models` folder existed, at both sizes and in both modes. The list groups its rows as **Already on this computer** and **Download**.
- `windows-settings-downloading-ultra-1280x800-dark.png`: Enter then chose it. The setting became `parakeet-ultra-int8` and the download started from `speech-model-parakeet-ultra-int8-1` ("Downloading · 18 of 671 MB"). Sotto was quit while it ran.
- `windows-settings-resumed-download-1280x800-dark.png`: the next start picked the download up at 45.9 MB, from the partial file, and reached **Ready** about three minutes later. The four files on disk match their pins.
  - These two were taken before the download rows were shortened. They show the label this change replaced: "Parakeet Ultra (download, 671 MB)", cut off in the closed list.
- **Transcripts, with Parakeet Ultra ready:**
  - Common Voice English: "Joe Keaton disapproved of films and Buster also had reservations about the medium."
  - German, from Multilingual LibriSpeech: "Denken Sie, soeben walten meine Gedanken bei Ihnen in Adelaide, und ich wünschte mir, Sie, Herr Sauben, zu können. Nun. Der Saube ist gelungen, lachte Münchhausen. Da bin ich, und was mich herführt?"
  - French, from Multilingual LibriSpeech: "Pendant le second siècle, je fis serment d'ouvrir tous les trésors de la terre, à quiconque me mettrait en liberté, mais je ne fus pas plus heureux. Dans le troisième je promis de faire puissant monarque mon libérateur, d'être toujours près de lui en esprit,"
- `windows-settings-ultra-after-restart-1280x800-dark.png`, `windows-settings-ultra-ready-820x560-dark.png`: on a third start, Parakeet Ultra was ready at once, with nothing downloaded. Settings shows "Speech recognition by Moondream, on this computer. 25 European languages.", **Ready.** and "671 MB on this computer.". The list shows Parakeet Ultra under Already on this computer, and Parakeet v3, 670 MB and Parakeet v2, 661 MB under Download.

- **Choosing from the open list after arrowing.** The same profile, with Parakeet Ultra ready, was checked after the review fix. Two down arrows moved the list to Parakeet v2, but nothing was chosen. Clicking the list then put it back on Parakeet Ultra as it opened, so that choosing Parakeet v2 in it was a change. Choosing Parakeet v2 saved the choice, let go of Ultra and started v2's download from `speech-model-parakeet-tdt-0.6b-v2-int8-1` (661,190,513 bytes).
- `windows-settings-v2-ready-1280x800-dark.png`, `windows-settings-v2-ready-820x560-dark.png`: after Sotto was quit while v2 downloaded, the next start resumed it at 37.2 MB and reached **Ready** 183 seconds later. Its four files match their pins.
  - The list reads Parakeet Ultra and Parakeet v2 under Already on this computer, then Parakeet v3, 670 MB under Download.
  - v2 wrote the English clip as Ultra did. The German clip came out as English-sounding words ("Tankenzie, so Eben Walten…"), as an English-only model does.

How the models were made and checked before publishing is in [2026-10-20-sotto-speech-models.md](2026-10-20-sotto-speech-models.md).

## Not checked here

- Linux in the running app. The unit tests cover its listing and its keyboard rule; on forge it needs a run like the Windows one.
- On a Mac, Sotto's three downloads beside FluidAudio's models, and the rule that leaves out a download of a model FluidAudio already keeps. Unit tests cover both.
- The design-capture baselines for the speech model step and Settings → Transcription change on purpose, and were not regenerated: the Mac's renders already differed from them on `main`, and this change moved the rows again.
