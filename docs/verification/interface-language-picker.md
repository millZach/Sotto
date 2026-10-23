# Interface language picker verification

October 23, 2026. The first part of ADR-0123 on `feat/interface-language` from `main` at 452fa2729, on Windows 11 with the built app (`npm run build`), the `interface-language` Owl feature turned on with `SOTTO_OWL_FEATURES`. The picker is variant A of the prototype tagged `prototype/interface-language`: one **Language** row at the top of Settings → Appearance.

What this part covers: the setting, the thirty languages and how the computer's language picks one, the catalogs and their check, the picker, and the first messages: the Appearance section's own words, the picker's, the tray's and the application menu's, drafted for all twenty-nine other languages. The rest of the window is still English, as the screenshots show; the other areas follow in their own pull requests. Right-to-left styling beyond the picker and bundled fonts come later.

## How it was run

```sh
npm run build
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/interface-language.spec.ts --workers=1
```

The spec launches the built app in end-to-end mode, which reads English as the computer's language, opens Settings → Appearance and chooses each language from the keyboard: open the list, type, Enter. Each capture checks first that nothing in the row or its list overflows the form or the window. The window is 1600x1000, 1280x800 and the 820x560 minimum; the captures are at 150% display scaling.

## What the captures show

- [English, 1600x1000](../../artifacts/interface-language/english-1600x1000.png), [1280x800](../../artifacts/interface-language/english-1280x800.png) and [820x560](../../artifacts/interface-language/english-820x560.png): the row above the colour scheme, with the Languages icon, the **Preview** mark, its description and **Same as this computer (English)**.
- [The list, 1280x800](../../artifacts/interface-language/english-list-1280x800.png) and [820x560](../../artifacts/interface-language/english-list-820x560.png): the Preview note, **Same as this computer (English)** first and checked, then each language in its own script with its English name beside it from the system's own list (`Intl.DisplayNames`). At the minimum the list opens over the themes inside the column and scrolls.
- [Japanese, 1600x1000](../../artifacts/interface-language/japanese-1600x1000.png), [1280x800](../../artifacts/interface-language/japanese-1280x800.png), [820x560](../../artifacts/interface-language/japanese-820x560.png) and [the list](../../artifacts/interface-language/japanese-list-1280x800.png), [at 820x560](../../artifacts/interface-language/japanese-list-820x560.png): the section heading, its line, the row and the confirmation **言語を保存しました。** are Japanese the moment the choice saves, with no restart. The English word **Language** stays beside **言語**. The names beside each language are now Japanese (アラビア語, ヒンディー語), and 日本語 is checked.
- [Japanese in the light room with reduced motion](../../artifacts/interface-language/japanese-light-reduced-motion-list-1280x800.png): the row, its mark and the open list take their colours from the theme. With reduced motion on, the spec checks in the light room and the dark that the field's transition is gone and the list opens at once; the row has no motion of its own beyond that.
- [Arabic, 1600x1000](../../artifacts/interface-language/arabic-1600x1000.png), [1280x800](../../artifacts/interface-language/arabic-1280x800.png) and [820x560](../../artifacts/interface-language/arabic-820x560.png): the window keeps its English layout. The heading **المظهر** and the label stay where English puts them; the section's line, the row's description and the contrast description run right to left from the right edge of their boxes (the `tt-paragraph` class, which the spec checks on every paragraph of the section); the chosen name **العربية** sits at the left of the field, where the English value sits. The confirmation is written in Arabic because a choice confirms itself in the language chosen.
- [en-XA](../../artifacts/interface-language/pseudo-en-XA-820x560.png) and [ar-XB](../../artifacts/interface-language/pseudo-ar-XB-820x560.png) at 820x560: the two pseudo-languages an unpackaged run shows with `SOTTO_INTERFACE_LANGUAGE`. The accented, longer English still fits the row; the picker never lists either.

The spec also checks, without captures, that a reload after choosing Japanese draws its first frame in Japanese, though the window's arguments still say English: the window remembers the language it shows for its own reloads. It checks that with the computer's languages set to Korean then Japanese the window opens in Japanese and the field reads **このコンピューターと同じ（日本語）**, that **Same as this computer** brings English back, and that with the Owl feature off the row does not exist and the window stays English even when the computer is Japanese.

## Keyboard and names

The field is a combobox named by the label and its value (**Language Same as this computer (English)**) and described by the row's description. ArrowDown, Enter or Space open the list on the chosen language; the arrow keys, Home, End, PageUp and PageDown move; typed letters find a language by its own name, its name here, its English name or its code; Enter picks; Escape closes without choosing and Tab closes and moves on. Focus stays on the field throughout. `tests/unit/renderer/features/settings/languagePicker.test.tsx` covers these.

## The tray and the menu

The tray menu and the macOS application menu are built again in the new language when it changes. An end-to-end run makes no tray, so `tests/unit/main/interfaceLanguage.test.ts` checks both in Japanese and German from the real catalogs. They were not looked at on a Mac or in the Windows notification area for this note.

## Not checked here

The floating widget loads the catalogs and follows the language, but none of its words are messages yet. The Japanese captures show the computer's Japanese font with Figtree's tracking; per-script type is a later part of ADR-0123.
