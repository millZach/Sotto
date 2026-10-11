# Add project on any paired computer: verification

September 26, 2026, branch `feat/host-folder-browser`, on the Windows 11 development machine. The owner's pick and answers are in `docs/plans/host-folder-browser.md`; the protocol and its limits in ADR-0025's September 26 amendment.

## In the running app

`tests/e2e/host-folder-browser.spec.ts` launches the built app with this computer as the only host and a throwaway home folder (so the captures show fixture folders, not the machine's own), and checks:

- Add project skips the computer step and opens in the home folder, with **Home** as the current crumb and the search field focused.
- Only folders are listed, and not `.config`: `code`, `Documents`, `models`. A folder with `.git` is marked **Git**.
- **Browse with File Explorer** is offered for this computer.
- **Enter** opens the highlighted folder, **Backspace** in the empty search goes up one, and **Escape** closes the dialog and gives focus back to Add project.
- **New folder** names `voice-lab`, the dialog says it is made on Use this folder, and **Use this folder** adds the project `voice-lab` and makes the folder, which the host then lists.
- At 1600x1000, 1280x800 and the 820x560 minimum, in dark and light, the page does not scroll sideways, and New folder and Use this folder stay in the window. At 820x560 the key hints are hidden, as New thread hides them.

The captures in `artifacts/host-folder-browser/`:

- `code-1600x1000-dark.png`, `code-1280x800-light.png`: the `code` folder, with the Git mark.
- `code-820x560-dark.png`, `code-820x560-light.png`: the same at the minimum window.
- `new-folder-1280x800-dark.png`: inside a new folder, before Use this folder.

The crumbs are long in these captures because the throwaway home is under the temporary folder; a real home folder sits three crumbs below the top.

`tests/e2e/thread-creation.spec.ts` and `tests/e2e/thread-worktrees.spec.ts` pass with New thread's Local folder now opening the browser, choosing through its File Explorer button.

## Covered by tests only

- The computer step, the choice of forge, the Git and Project marks for forge, a folder forge cannot read, a disconnected host, and Add project selecting the chosen host before `create-project`: `tests/unit/renderer/folderBrowserDialog.test.tsx`.
- Listing, the drives on Windows, dot folders and files left out, links followed, the cap, and refusing a network share or device path: `tests/unit/main/hostFolders.test.ts`.
- `host-folders` over a real socket, and a host without the feature refused before anything is sent: `tests/integration/socketHostFeatures.test.ts`, `tests/integration/socketHostCompatibility.test.ts`.
- The desktop sending a listing to the host it names, not the host for new work: `tests/unit/main/desktopHostRouter.test.ts`.

## Not yet done

No Playwright fixture stands for a remote host, so the computer step has not been captured in the app. It has not been tried against Forge either: Forge runs the 0.1.16 host, which does not list `host-folders`, so this desktop would say which side to update until the new host archive is placed there. The hand test still owed is: on Forge with this build's host, press Add project, choose forge, open a folder, add a project, and send a thread in it.
