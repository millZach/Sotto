# Add project opens a new thread verification

October 16, 2026. On `fix/add-project-opens-thread` from `main` at c134d3510.

## What was wrong

Add project made the folder a project and selected it, but opened no pane. The Threads page then showed what it shows
with no pane open: here, a draft saved for another thread ("Your draft for Fix Codex wake-ups, remove frosted UI, sync
Forge updates is saved."), with the new project listed and empty.

## What it does now

Add project hands the project to the sidebar it was pressed in, once the window's state lists it, and the sidebar opens
its own New action there: a new thread from the Threads sidebar, the same one the project's pen opens, and New terminal
for the project from the Terminal sidebar. A folder that is already a project gets the same. First-run setup's project
step is unchanged. Beside another page, the sidebar there lists threads, so a new thread from it turns the remembered
mode back to Threads; before, with Terminal remembered, the thread opened behind the Terminal workspace.

## In the built app

`tests/e2e/add-project-opens-thread.spec.ts` drives the built app at 1280x800, dark, with a throwaway profile and home
folder and the test providers.

- New folder `voice-lab` with Use this folder: the dialog closes and a new thread opens in `voice-lab`, its composer
  focused, the project's one thread
  ([`new-folder-thread-1280x800-dark.png`](../../artifacts/add-project-opens-thread/new-folder-thread-1280x800-dark.png)).
- `voice-lab` again, which is now a project, with Open project: its unused new thread opens, and no second is made.
- Terminal sidebar, folder `sotto`: New terminal opens on its form for `sotto`, and no thread is made
  ([`terminal-new-terminal-1280x800-dark.png`](../../artifacts/add-project-opens-thread/terminal-new-terminal-1280x800-dark.png)).
- History, with Terminal still the remembered mode, folder `forge-ml`: Threads opens in Threads mode with a new thread in
  `forge-ml`
  ([`from-history-thread-1280x800-dark.png`](../../artifacts/add-project-opens-thread/from-history-thread-1280x800-dark.png)).

Not checked here: a project on a remote host, which takes the same path once the host's state lists the project.
