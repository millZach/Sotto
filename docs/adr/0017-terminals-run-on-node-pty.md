# Terminals run on node-pty, Sotto's second production dependency

Accepted September 19, 2026, recording a decision the code made on September 13 (commit `28677a6`, which externalised `node-pty` for the Tools panel terminal) without a record of its own. `AGENTS.md` and ADR-0016 both still said production dependencies were exactly `zod`; this ADR is why they now say otherwise.

## Context

A terminal in Sotto — the Tools panel's terminal beside a thread's working copy, and Terminal mode's shells and provider CLIs — has to be a real terminal. Codex, Claude Code and Grok Build draw their own interfaces: they ask the terminal its size, redraw in place, read raw key presses and refuse to behave when what they are talking to is a plain pipe. Node's `child_process` offers pipes and nothing else. Electron ships no pseudo-terminal of its own, and Chromium's `xterm` in the window is only the drawing half: something in main has to own the process and the terminal it believes it is attached to.

The rule that production dependencies are exactly `zod` exists so that what ships is what was reviewed: `scripts/release-external-dependencies.mjs` fails the release when the built inventory names anything else, and every other library is compiled into a bundle at build time or is a Node builtin. A pseudo-terminal cannot be compiled in. It is a native module, with a Windows ConPTY agent, WinPTY fallback binaries and a Unix spawn helper that must exist as files on disk at their expected relative paths.

## Decision

**`node-pty` 1.1.0 is a pinned production dependency, and the only one besides `zod`.** `src/main/terminals/service.ts` is its sole importer and loads it once per session with a dynamic `import('node-pty')`, so a machine where the native module cannot load still starts Sotto; the terminal reports itself unavailable and nothing else is affected.

**It stays outside the bundle and outside the archive.** `electron.vite.config.ts` lists it as a Rollup external, `electron-builder.yml` unpacks `node_modules/node-pty/**` from `app.asar`, and `scripts/release-external-dependencies.mjs` names it as the one allowed dynamic external of main. A bundled copy loses the relative paths its helpers are found by; that was the `unavailable` startup error in `docs/verification/2026-09-14-tools-sidebar-terminal.md`.

**Windows ships the Node-API prebuild; macOS rebuilds.** The Windows source rebuild fails in a checkout path with spaces, and the prebuild passed the packaged terminal probe, so `npmRebuild: false` is the default and the macOS `package:*` scripts pass `--config.npmRebuild=true` explicitly (`docs/verification/phase-3-packaged-windows.md`).

**Its notices ship with it.** `THIRD_PARTY_NOTICES.md` carries the MIT texts for `node-pty`, `winpty` and the transitive `node-addon-api`, and `npm run notices:verify` checks them.

## Considered options

- **Pipes through `child_process`.** No TTY, so the provider CLIs either refuse to start or print without redrawing. Fine for the one-shot commands Sotto runs for git and file tools; not a terminal.
- **Drive an external terminal application.** Sends the user out of Sotto for the thing the Tools panel exists to keep beside the thread, and gives Sotto no output to read.
- **A pure-JavaScript pseudo-terminal.** None exists for Windows; ConPTY is an operating-system API and has to be reached natively.
- **Bundle `node-pty` like everything else.** What the build did before `28677a6`: the helpers are found relative to the package layout, and the bundled copy could not find them.

## Consequences

The release inventory now has two names, and the rule reads "exactly `zod` and `node-pty`". A third name is still an ADR before it is a dependency.

The native module is compiled against an Electron ABI. Every Electron upgrade re-runs the packaged terminal probe on both platforms before the version is bumped, because a prebuild that no longer matches fails at load time in the installed app and not in the test suite. Verification records live in `docs/verification/phase-3-*.md`.

Terminals are the one feature that can be missing on a machine where the rest of Sotto works. The error the user sees says the terminal is unavailable and nothing is lost; the rest of the Tools panel, the threads and dictation are untouched.
