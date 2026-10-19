# Settings > Dictation shortcuts (Variant C)

October 19, 2026, on an Apple silicon Mac, against the built app (`npm run build`, run by `npm run design:capture`). Every run used a fresh `sotto-e2e-*` profile in the temporary folder, removed afterwards; the user's own profile was never opened. The screenshots came from a throwaway Playwright script kept outside the repository. It launches the app the way the design captures do (`launchSotto` with the `success` scenario, `--force-device-scale-factor=1`, America/Los_Angeles, en-US), writes `settings.json` itself, and turns the Owl feature on or off with `SOTTO_OWL_FEATURES=dictation-hold-shortcuts=1` or `=0`, which an unpackaged run honours (`owlFeaturesForRun`).

## What changed

Settings > Dictation lost its "Global shortcut" text field. In its place are the shortcut rows: "Press to start and stop" in stable, and "Hold to dictate" above it with the Owl feature on. Each shortcut is a button of key chips that records new keys when pressed. With the Owl feature on, each row also has a × to remove a shortcut and + Add, which on macOS opens a menu with "Record keys…" and "Fn on its own". The notes and the footer sit under the rows.

## What was shown

- Stable shows the one "Press to start and stop" row, with no ×, no + Add and no "Hold to dictate", in dark and light at 1600x1000, 1280x800 and 820x560.
- With the Owl feature on and `holdShortcuts: ["Fn"]`, both rows show. The Fn note ("If Fn opens emoji or Apple's dictation, …") shows because a shortcut uses Fn.
- At 820x560 the chips and + Add move under their labels, in stable and Owl. At every size, `pageBoundProblems` (the design captures' own check) found no horizontal overflow and no clipped control.
- Pressing the press row's chips opens the recording box, reading "Press the new keys…" with "Cancel recording", and the status line reads "Hold the keys you want, then let go. Esc cancels." With Control and Shift held, the box shows their live chips and the status reads "Let go to save. Esc cancels."
- Letting go of a chord with no key, recorded into the main press shortcut, is refused with the alert "Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere. Add this one with + Add instead." The saved shortcut does not change.
- + Add on the hold row opens the menu with "Record keys…" and "Fn is already in use", greyed out, because Fn is already a hold shortcut.
- Keyboard focus on the press chips shows the teal focus ring around the whole button.
- With Reduced motion on (`data-reduced-motion="on"`), the rows show the same way and nothing moves.
- Text contrast was judged by eye only, not measured. Labels, descriptions, chips, notes and the red alert all read clearly in dark and light.

## Defects seen

- **Found and fixed: the shortcut rows sat 16 px inside the other Settings rows.** Their labels and notes started 16 px right of Microphone, Recording limit and Sound cues, and the chips ended 16 px short of the shared right edge. `dictationShortcuts.css` no longer insets them, and the screenshots below were taken again after the fix.
- **The + Add menu covers the row below it.** On the hold row it opens downwards over the press row's chips while it is open (`owl-dark-add-menu.png`). This is minor, since it is a popover that closes on Escape.
- **Not caused by this change:** at 820x560 the page footer "Changes save as you make them." sits over the bottom of the Sound cues switch (`stable-dark-820x560.png`). That footer belongs to every Settings page.

## Captures

In [`artifacts/dictation-shortcuts/`](../../artifacts/dictation-shortcuts/):

- Stable at each size and theme: [`stable-dark-1600x1000.png`](../../artifacts/dictation-shortcuts/stable-dark-1600x1000.png), [`stable-dark-1280x800.png`](../../artifacts/dictation-shortcuts/stable-dark-1280x800.png), [`stable-dark-820x560.png`](../../artifacts/dictation-shortcuts/stable-dark-820x560.png), [`stable-light-1600x1000.png`](../../artifacts/dictation-shortcuts/stable-light-1600x1000.png), [`stable-light-1280x800.png`](../../artifacts/dictation-shortcuts/stable-light-1280x800.png), [`stable-light-820x560.png`](../../artifacts/dictation-shortcuts/stable-light-820x560.png).
- Owl, both rows: [`owl-dark-rows-1280x800.png`](../../artifacts/dictation-shortcuts/owl-dark-rows-1280x800.png), [`owl-dark-rows-820x560.png`](../../artifacts/dictation-shortcuts/owl-dark-rows-820x560.png), [`owl-light-rows-820x560.png`](../../artifacts/dictation-shortcuts/owl-light-rows-820x560.png).
- Recording, before and with keys down: [`owl-dark-recording-empty.png`](../../artifacts/dictation-shortcuts/owl-dark-recording-empty.png), [`owl-dark-recording-keys-down.png`](../../artifacts/dictation-shortcuts/owl-dark-recording-keys-down.png).
- The refusal: [`owl-dark-validation.png`](../../artifacts/dictation-shortcuts/owl-dark-validation.png).
- The macOS + Add menu: [`owl-dark-add-menu.png`](../../artifacts/dictation-shortcuts/owl-dark-add-menu.png).
- Keyboard focus on the press chips: [`owl-dark-focus-ring.png`](../../artifacts/dictation-shortcuts/owl-dark-focus-ring.png).
- Reduced motion: [`owl-dark-reduced-motion.png`](../../artifacts/dictation-shortcuts/owl-dark-reduced-motion.png).

## Design baselines

The baselines were not regenerated. The committed ones were rendered on Windows. Running `npm run design:capture` on this Mac changed every capture by a pixel of width, so every baseline was put back as it was. The Settings › Dictation baselines need regenerating with `npm run design:capture` on the Windows PC.

## E2E

The macOS e2e conflict spec failed on the first review. It was fixed by comparing chords by their set of keys in the e2e shortcut adapter.

## Not verified

- **The Input Monitoring note and the dimmed hold chips were not produced.** Without the built Mac key-listener helper, the listener never reports a permission. The router reads that `unknown` as `not-needed`, so the renderer never sees `denied`.
- **Fn and hold on a real keyboard with Input Monitoring granted.** Playwright cannot send Fn, and no physical key was pressed.
- **The packaged Mac helper** (`native/key-listener/darwin.swift`), built and signed in a package.
- **The Windows hook** (`keyListenerWin32`). It was never run, and Windows was not captured.
- **Microsoft Defender's reaction to the Windows hook.**
- Focus rings on ×, + Add and the menu items. Only the chip button was focused from the keyboard.
- Measured contrast ratios. Contrast was judged from the screenshots by eye.
- The conflict and unavailable messages and "Shortcut saved.".
