# Tools and the Terminal drawer return to a pane's header

November 2, 2026. The branch `fix/pane-header-tools-terminal` from `main` at 613c02dfe, recorded in ADR-0182.

## What was proved

Run in the built app on forge, under Xvfb, one journey at a time.

- The header's order is the Git action, Watch, Tools, the Terminal drawer, `···` and, in a split, close, in both panes at 1600x1000 and 1280x800, and in the shown pane on tabs at 820x560 with nothing past the row's edges.
- Moving focus between panes moves no control in either header.
- Neither Tools nor the Terminal drawer is a row of `···`. Open beside still is.
- The drawer's button and Ctrl+J show and hide the drawer, and the button says which it would do.
- In a pane without focus, Tools focuses the pane and opens the panel; pressed again there, it closes it.
- A 126-character name at 1280x800 is the only thing cut off in its row, with its full text in the heading's title. At 1600x1000 the same name shows whole. A short name leaves no more than the row's own gap before the project.
- A thread on a real paired headless host shows the Terminal drawer's button greyed, naming that host from its connection. A press opens nothing, it takes keyboard focus and it describes itself, and Tools works there.

## How it was run

```sh
npm run build
SOTTO_E2E_EVIDENCE=publish xvfb-run -a -s "-screen 0 2000x1200x24" npx playwright test tests/e2e/pane-header.spec.ts --workers=1
```

## Captures

In `artifacts/pane-header-tools-terminal/`, each in `-dark.png` and `-light.png`:

- `split-1600x1000`: two panes, each with all its controls and its title, project and folder whole.
- `menu-1600x1000`: the left pane's `···`, without Tools or the drawer.
- `split-1280x800`: the same split with less room.
- `tabs-820x560`: the minimum window, with the panes on tabs.
- `long-name-1280x800`, `long-name-1600x1000`: the long name cut off and whole.
- `short-name-1600x1000`: a short name, with no gap after it.
- `paired-host-1280x800`: a thread on a paired host, with the greyed symbol focused.

## Not proved here

- Windows and macOS. Linux draws no window controls, so the pane under them was not exercised.
- `remote-thread-tools.spec.ts`, `files-panel.spec.ts`, `files-panel-split.spec.ts` and one journey of `tools-sidecar.spec.ts` stopped before reaching this change: the fake SSH host never finished connecting, or a sidebar row never listed, as `docs/verification/pane-header-one-menu.md` recorded on this desktop. `remote-roster.spec.ts` stopped at a line it words for Windows and macOS. CI's Windows journeys run them.
