# The Plugins page, with GitHub's row

Checked on Windows on November 11, 2026, in the built app, for #2486: the first slice of
`docs/plans/2026-11-11-plugins.md`. On Owl, Settings has a **Plugins** page after Providers, laid out as Zach's pick A of
`docs/prototypes/plugins-settings-prototype.html`: every plugin is a row in its group, and a row opens in place. GitHub
is the only row so far. ADR-0205 records the decision.

`gh` was a stand-in (`tests/fixtures/fakeGhSignIn.mjs`) that answers `gh auth status` from a file and reaches nothing, so
the account shown is made up. The run is `tests/e2e/plugins-settings.spec.ts`, with the Owl feature turned on by
`SOTTO_OWL_FEATURES=plugins=1`.

## What was done

With the stand-in signed in as `example-user`, Settings was opened. Plugins sat directly after Providers in the rail.
GitHub's folded row read "GitHub, Signed in as example-user through gh". The row was focused and opened with Enter, and
said "Signed in as example-user through gh on this computer." and that Sotto stores nothing for it.

The open page was checked in dark and light at 1600x1000, 1280x800 and the 820x560 minimum. Nothing on it was wider than
the room it sits in at any of the six.

The stand-in was then signed out and **Check again** pressed. The row read "Not signed in" and showed `gh auth login`
with **Copy**. Last, with Providers open, "GitHub" was typed into **Find a setting** and Enter pressed: Plugins opened
with the row in view.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/plugins-settings/plugins-github-signed-in-dark-1280x800.png` | Signed in, row open and focused, dark |
| `artifacts/plugins-settings/plugins-github-signed-in-light-1280x800.png` | The same in light |
| `artifacts/plugins-settings/plugins-github-signed-in-dark-1600x1000.png` | The same at 1600x1000 |
| `artifacts/plugins-settings/plugins-github-signed-in-dark-820x560.png` | The same at the minimum window |
| `artifacts/plugins-settings/plugins-github-signed-out-dark-1280x800.png` | Signed out: the command to run, Copy and Check again |

The row's only motion is its chevron turning, which stops under reduced motion. Its colours come from theme roles in
`src/renderer/src/features/settings/plugins.css`, which `themeTokens.test.ts` and `scaleTokens.test.ts` check. GitHub's
icon is its own mark in the theme's text colour, the way provider marks are drawn.

## Not checked here

- **A real `gh`.** The unit test `tests/unit/main/plugins/gitHubSignIn.test.ts` covers what `gh` prints when signed in,
  signed out, missing, too old for `--json`, or unreadable. Nothing here asked the real `gh` on this computer.
- **Stable, beyond the rail.** With the Owl feature off, `tests/e2e/settings-pages.spec.ts` was run and the rail it
  read held no Plugins page. That spec then fails for another reason: its own list of pages is out of date and lacks
  Watcher and Performance (#2505), so its size checks did not run.
- **macOS and Linux.** The spec runs on Windows only, as the other Settings specs do.
- **Agent tools.** There are none yet. Slice 2 (#2487) adds them; until then the page only shows the sign-in.
