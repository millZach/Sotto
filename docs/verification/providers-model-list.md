# A provider's models in a small searchable list

Checked on Windows on October 26, 2026, in the built app over the fake Devin CLI (`tests/fixtures/`). Zach asked for
three things on Settings › Providers: every provider closed on arrival, no unavailable models, and a provider's models in
something small and searchable like the model picker, so one provider's list does not take up the screen. Every row
already started closed on `main`. This change does the other two: an open row's Models column became a Models line with a
small field, and the list it opens leaves out models the provider cannot run. Zach picked the layout (A) and a list to
browse rather than a choice from `docs/prototypes/providers-settings-prototype.html`.

## What was done

Sotto was launched on a fresh profile with the fake Devin CLI, Devin was connected from its row, and the page was
captured closed, with Devin open, with its model list open, and with "fixture" typed in the list's search, at 1600x1000,
1280x800 and the 820x560 minimum, in dark and light, with reduced motion on. At every size and in both themes the list
stayed inside the window, Escape cleared the search and then closed the list, and focus went back to the field.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/providers-model-list/closed-1280-dark.png` | Every row closed on arrival, dark, 1280x800 |
| `artifacts/providers-model-list/open-1280-dark.png` | Devin open: connection, the Models field, installed client |
| `artifacts/providers-model-list/models-1280-dark.png` | The list open over the page, with Agent setting beside the model new threads start on |
| `artifacts/providers-model-list/models-search-1600-light.png` | Searching the list, light, 1600x1000 |
| `artifacts/providers-model-list/open-820-light.png` | Devin open at the minimum window, light |
| `artifacts/providers-model-list/models-820-light.png` | The list at the minimum window, light |

The list's colours come from theme roles in `src/renderer/src/agents/providers.css` and the model menu's own
`modelPicker.css`, which `themeTokens.test.ts` checks. The row's arrival animation is unchanged, and the list itself does
not move.

## Not checked here

The fake Devin lists one model, so a long list was checked in the unit tests rather than on screen, as were leaving out an
unavailable model, a provider with no usable model, and Cursor's makers and OpenCode's model sources keeping their groups.
`tests/e2e/cursor-provider.spec.ts` opened Cursor's list in the built app and checked its makers and their contrast at
every size. macOS and Linux were not checked. The design capture baselines for this page
(`artifacts/design/app-review/baseline/settings-providers*.png`) still show Codex's row open with its Models column, from
before every row started closed. The capture opens no row, so this change alters nothing it would draw; the baselines are
out of date from that earlier change and were not regenerated here.
