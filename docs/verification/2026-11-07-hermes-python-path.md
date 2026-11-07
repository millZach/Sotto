# Hermes's reported Python matches its terminal — November 7, 2026

Started from Drake's local Owl commit `87c33855a32501c645047decce648537ccdc4a91`.
The installed `0.1.43-owl.20261107.3` bundle's `out/build-provenance.json` names that same commit.
This is a local Owl fix only; no push, pull request, merge or installation.

## Cause

`findHermesExecutable` finds the pinned
`/Users/drakemorey/Developer/Tools/hermes-v0.23.0/.venv/bin/hermes`.
The shared CLI lookup remembers its folder as a PATH prefix. All four Hermes
launch paths passed their environment through `withCliPath`, placing that private
venv before the user's tools. Hermes's launcher already has an absolute shebang
pointing at its own venv Python, so it does not need that PATH prefix.

Hermes's `tools/env_probe.py` calls `python3` on the process PATH. Its terminal
instead captures a login-shell snapshot: `tools/environments/base.py:422` calls
`_run_bash(..., login=True)`, and `tools/environments/local.py:1143` uses `bash -l`.
On this Mac, `/etc/profile:4` runs `path_helper`, which puts `/usr/bin` before the
venv. Captured PATHs confirmed the venv first in the probe's process and
`/usr/bin` first in the terminal. The paths diverge at that login-shell snapshot.

## Change

`withHermesPath` first calls the shared `withCliPath`, then removes only the
folder returned by `dirname(executable)`. The version check, ACP viewer, gateway
and Python readiness/profile helpers all use this Hermes-specific environment.
Node's discovered folder and all login-shell additions keep their existing
order. Hermes's absolute launcher and helper interpreter still select its
private Python. Other providers and the shared CLI lookup are unchanged.

The first local fix bypassed `withCliPath` entirely. It passed from a terminal
with a full PATH but would discard useful discovered folders when Sotto starts
from the Dock. This revision preserves those folders and removes only the
private Hermes folder. No Hermes source, shell profile or terminal configuration
was changed.

## Native verification outside Sotto

The checks used the installed Hermes 0.23.0, upstream `2bd378ed`, with fresh
temporary homes and Sotto's configuration. A bundled copy of Sotto's actual
`HermesAcpHost` started the gateway and ACP viewer. The original before bundle
read the two launch modules from `87c33855a`; the revised after bundle read
this change.

A loopback model server captured the system prompt and requested the real
native `terminal` tool. No Sotto app instance or external model service was used.

Before, the model received:

```text
Python toolchain: python3=3.14.9 (no pip module), pip=missing, PEP 668=yes (use venv or uv), uv=installed.
```

Its actual terminal result was:

```text
/usr/bin/python3
Python 3.9.6
```

After, the model received no `Python toolchain:` warning line. This is Hermes's
normal behavior for a healthy toolchain, not a replacement warning or suppressed
probe. A direct call to its unchanged `_python_version_of('python3')` and
`_build_probe_line()`, using Sotto's launch environment, confirmed:

| Evidence | Before | After |
| --- | --- | --- |
| Probe's `python3` path | Hermes `.venv/bin/python3` | `/usr/bin/python3` |
| Probe's Python version | `3.14.9` | `3.9.6` |
| Probe warning | `python3=3.14.9` | Empty: healthy toolchain |
| Native terminal | `/usr/bin/python3`, `Python 3.9.6` | `/usr/bin/python3`, `Python 3.9.6` |
| Hermes's own interpreter | `3.14.9` | `3.14.9` |

### Bare and full PATH verification

The revised check ran twice through the real gateway, ACP session and native
terminal. The bare run started with exactly:

```sh
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /Users/drakemorey/.local/share/fnm/node-versions/v24.22.1/installation/bin/node \
  /tmp/sotto-hermes-launch-probe.mjs bare
```

The full run used the same absolute Node executable with the terminal's full
inherited environment and the `full` argument. The launcher executable did not
alter PATH. Each run completed four model requests, discovered the MCP schemas
and settled idle.

| Evidence | Bare PATH | Full shell PATH |
| --- | --- | --- |
| Probe resolution | `/usr/bin/python3`, `3.9.6` | `/usr/bin/python3`, `3.9.6` |
| Native terminal resolution | `/usr/bin/python3`, `Python 3.9.6` | `/usr/bin/python3`, `Python 3.9.6` |
| Probe warning / model warning | Empty / absent | Empty / absent |
| Non-login `node` | `/usr/local/bin/node`, `v24.14.0` | fnm multishell `bin/node`, `v25.8.2` |
| Native terminal `node` | `/usr/local/bin/node`, `v24.14.0` | `/usr/local/bin/node`, `v24.14.0` |
| `uv`, in both contexts | `/Users/drakemorey/.local/bin/uv`, `0.10.7` | Same |
| `git`, in both contexts | `/usr/bin/git`, `2.54.0 (Apple Git-157)` | Same |
| Sotto MCP discovery | 8 servers, all 30 tools | 8 servers, all 30 tools |

The full shell's fnm Node remains first for non-login subprocesses. The terminal
still uses its normal login-shell Node. Both resolve; this fix deliberately
preserves that existing ordering.

For the bare run, `withCliPath` added Hermes's venv, `/usr/local/bin`,
`/Users/drakemorey/.local/bin`, macOS login paths and `/opt/homebrew/bin`.
The launch environment kept every addition except the venv. Its PATH began
`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/drakemorey/.local/bin`.
Neither revised launch PATH contained Hermes's venv. Hermes's unchanged
login-shell setup can still include that folder later in the terminal PATH;
`python3` resolves to `/usr/bin/python3` ahead of it.

### Sotto MCP tools

These are Sotto's actual server classes with their optional surfaces enabled,
passed through `useBrowserTools` and `useThreadTools`. They run inside the host
and expose authenticated loopback HTTP endpoints; they are not programs
launched by bare names. Each endpoint's `tools/list` matched its definitions.
The model then used Hermes's native `tool_search` and `tool_describe` to retrieve
all 30 schemas under Hermes's session-specific `mcp__editor_...` names.
No Sotto action tool was invoked.

Every row passed in both environments:

| Server | Tools |
| --- | --- |
| `sotto_browser` | `browser_pages`, `browser_open`, `iphone_open`, `browser_start`, `browser_action`, `browser_status`, `browser_finish`, `iphone_cloud_open`, `iphone_cloud_action`, `iphone_cloud_status`, `iphone_cloud_finish` |
| `sotto_host_setup` | `host_status`, `host_check`, `host_add`, `provider_status`, `provider_check` |
| `sotto_visual` | `visualize` |
| `sotto_media` | `show_in_thread` |
| `sotto_pull_requests` | `babysit_pull_request`, `stop_babysitting`, `list_babysitting` |
| `sotto_delegate` | `delegate`, `read_delegation`, `cancel_delegation`, `list_machines` |
| `sotto_watcher` | `tell_watcher`, `ready_to_merge` |
| `sotto_council` | `ask_council`, `start_climb`, `read_council` |

These cover every server offered to Hermes in `src/main/index.ts` and
`HermesAcpHost.toolServers`. Watcher's separate thread-management server is not
offered to Hermes: Hermes cannot host Watcher.

## Checks and build

The regression test covers both bare and full inherited PATHs. It discovers a
private venv through the actual CLI lookup, confirms the shared helper's exact
PATH, then checks that every Hermes launch receives that PATH with only the
private folder removed. It checks that the readiness/profile helpers still use
the absolute private interpreter, and that the caller's environment and shared
helper behavior stay unchanged.

Passed with the repository's CI version, Node 24.22.1, in order:

- `npm run typecheck`
- `npm run lint`
- `npm exec -- vitest run tests/unit/main/hermes.test.ts` — 5 tests
- `npm exec -- vitest run tests/unit/main/hermesEnvironment.test.ts` — 2 tests

All four checks were rerun sequentially for this revision and passed. No full
suite, Playwright, e2e or Sotto app run was used.

The local build target is `0.1.43-owl.20261107.4` at
`release/mac-arm64/Sotto.app`. It follows the `.3` build's asset check, renderer
and main bundle, Core ML helper, key listener, build provenance and arm64
directory packaging, with the version supplied by electron-builder's
`extraMetadata.version` option. Source manifests stay at their existing version.
Packaging omits the app-launching verification commands and installation; the
completed bundle is checked through its manifest, signature and build provenance.
