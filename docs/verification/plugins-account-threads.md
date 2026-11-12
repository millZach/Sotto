# Which threads may use a plugin account

Checked on Windows on November 12, 2026, in the built app, for #2490: the fifth slice of
`docs/plans/2026-11-11-plugins.md`. An account on Settings › Plugins now has a switch that says whether threads may
use it, and can be kept to chosen projects. ADR-0205's decision 9 and its November 12 note on which threads may use
an account record the decision.

Vercel was a stand-in: a small server on this computer that knows one made-up token, reached through
`SOTTO_E2E_VERCEL_API_URL`. The run is `tests/e2e/plugins-account-threads.spec.ts`, with the Owl feature turned on
by `SOTTO_OWL_FEATURES=plugins=1`. The thread was a real Codex thread over the fake app server, in the project Lumen
shop, and its agent's tool calls went through the end-to-end hook `pluginTool`, which calls the same tool server a
provider's call reaches. A second project, Other site, was made for the run. Nothing reached Vercel.

## What was done

A Vercel account named Work was added. Before anything was changed, the thread's agent was told "Vercel: account
"Work"." and read deployments through it.

On Settings › Plugins the account showed **Threads may use Work** switched on and, under it, **Every project**
pressed beside **Lumen shop** and **Other site**, with "Threads in every project may use it, and so may Watcher."

**Other site** was pressed from the keyboard, with focus on it and Enter. It showed pressed, **Every project** no
longer did, and the line read "Only threads in Other site may use it. Watcher belongs to no project, so it cannot."
At its next call the thread's agent, in Lumen shop, was told "no account is available to this thread: the user has
switched it off or kept it to other projects", and a read that named Work outright was refused in the same words,
without the account's name. The stand-in was asked nothing for either.

The page was checked with the account kept to a project in dark at 1600x1000, 1280x800 and the 820x560 minimum, and
in light at 1280x800. Nothing on it was wider than the room it sits in at any of the four.

**Lumen shop** was pressed as well; the line read "Only threads in Other site, Lumen shop may use it." and the
thread's agent was told of Work again.

The switch was turned off. It read "Off. No thread can see or use this account until you turn it back on. Its token
stays saved.", the projects went away, the folded row read "Vercel, Work (off)" with its dot unlit, and the thread's
agent was told again that no account is available to it.

The switch was turned back on and **Every project** pressed: it showed pressed, the two projects did not, and the
thread's agent was told of Work once more. The made-up token was nowhere on the page.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/plugins-account-threads/account-kept-to-a-project-dark-1280x800.png` | The account kept to one project, dark |
| `artifacts/plugins-account-threads/account-kept-to-a-project-light-1280x800.png` | The same in light |
| `artifacts/plugins-account-threads/account-kept-to-a-project-dark-820x560.png` | The same at the 820x560 minimum, scrolled to the account |
| `artifacts/plugins-account-threads/account-off-dark-1280x800.png` | The account switched off |

## What unit tests cover instead

- `tests/unit/main/plugins/accounts.test.ts`: the switch and the projects are kept without touching the secret, an
  account from before the switch is on and for every project, and what a thread in a project, in another, and in
  none finds.
- `tests/unit/main/plugins/pluginChangeTools.test.ts`: no change is asked for through an account that is off or kept
  to another project, and one allowed on a card sends nothing when the account was switched off, narrowed or removed
  while the card waited.
- `tests/unit/renderer/features/settings/pluginsSettings.test.tsx`: the switch, the chips, a settled project and a
  project that is gone, and a change that could not be saved.
- `tests/unit/main/plugins/pluginsIpc.test.ts`: only the main window may change an account, and a project's folder
  never reaches the page.
- `tests/unit/main/plugins/projectFolders.test.ts`: a folder two providers work in is offered once, and an account
  kept to it is for that folder's threads on both. The run above had one provider, so this was not driven in the
  built app.

## Not checked

- Watcher's own thread reading through an account. The rule that it is in no project is covered by the unit tests,
  not driven in the built app.
- A real Vercel account. The switch and the projects never reach Vercel, so there is nothing of Vercel's to check.
