# Language is hidden until the desktop catalogs are drafted

October 27, 2026. ADR-0123's amendment of the same date, issue #1684.

## What changed

`INTERFACE_LANGUAGE_SHOWN` in `src/shared/interfaceLanguages.ts` is `false`. Main and Settings > Appearance read it
alongside the `interface-language` Owl answer, so Owl now does what stable already did: no Language row, English
whatever the saved choice or the computer's language, and a saved choice kept whole but not shown.

## How it was checked

Built app, `npm run build && SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/interface-language.spec.ts`:

- **Owl has no Language row and stays in English, whatever the computer's language**: launched with
  `interface-language=1` and Japanese as the computer's language. Appearance shows no `.language-picker`, and the
  window's `lang` is `en`. Passed.
- **Stable has no Language row and stays in English**: unchanged, passed.
- The three tests of the row itself (choosing a language, following the computer, the pseudo-languages) are skipped
  while the constant is `false`, with #1684 as the reason.

The end of the Details card, where the row stood, on Owl. It ends at Contrast at every size:

- [1600x1000](../../artifacts/interface-language/owl-hidden-1600x1000.png)
- [1280x800](../../artifacts/interface-language/owl-hidden-1280x800.png)
- [820x560](../../artifacts/interface-language/owl-hidden-820x560.png)

Unit: `tests/unit/renderer/features/settings/languagePicker.test.tsx` adds "does not exist on Owl either while it is
hidden, and the saved choice is left alone"; the row's own tests run with the constant turned on.
`tests/unit/main/settingsRepository.test.ts` already holds that a build with the feature off keeps a saved choice
through a save, a patch and a reset, and that it returns when the feature is on.
