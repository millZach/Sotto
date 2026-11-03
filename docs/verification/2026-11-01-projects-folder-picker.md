# Choosing the default projects directory in the folder browser

November 1, 2026. Settings → Threads → Projects no longer has a text box for the default projects directory. Each computer's row writes its folder out and opens Add project's folder browser on that computer (`docs/plans/projects-folder-picker.md`).

## In the running app

`tests/e2e/agents.spec.ts` drives the built app on this computer. It saves a folder one level inside a test folder, presses **Change…**, and checks that the browser opens at that saved folder. It goes up one folder, presses **Use this folder**, and checks that the setting holds the parent and the row shows it. Its captures are in `artifacts/projects-folder-picker/`:

- `browser-820-dark.png`: the browser at the 820x560 minimum, open at the folder to be chosen.
- `chosen-820-dark.png`: the chosen folder at 820x560. The long path wraps rather than overflowing, and **Clear** sits beside **Change…**.
- `chosen-1280-light.png`: the same at 1280x800 in light.

`tests/e2e/new-thread-defaults-hosts.spec.ts` does the same on a host started over the fake SSH. It opens forge's browser, opens `code` among forge's own folders and uses it. It then checks that forge's own projects directory is that folder, and that the row stays in view at 1600x1000, 1280x800 and 820x560 in dark and light. `tests/e2e/settings-index.spec.ts`, which CI's desktop check runs, chooses with Backspace to go up, and checks that the folder is still shown after leaving the page and coming back.

The design baseline `artifacts/design/app-review/baseline/settings-agents.png` was regenerated on purpose. It shows the empty row: **No folder chosen** and **Choose…**.

## Unit tests

`tests/unit/renderer/projectsDirectoryRow.test.tsx` covers:

- choosing on forge, starting at its saved folder, and saving with forge's host ID;
- choosing on this computer from its home folder;
- closing the browser, which saves nothing;
- forge not connected, where its folder stays shown but **Change…** is off and **Clear** is gone;
- forge dropping while the browser is open, which stops **Use this folder** and says why;
- **Clear**;
- a saved folder that has gone, which opens at home;
- a new folder's path;
- a save that fails, which keeps the browser open with an error, and a save never answered, which says it could not be confirmed;
- a listing that arrives after forge drops, which is dropped;
- `/` chosen as forge's projects folder;
- the keyboard staying on **Change…** while **Clear** saves;
- the one-computer row.

## Not checked

- The Mac and Linux builds, whose rows are the same code.
- A real forge, rather than the host started over the fake SSH.
