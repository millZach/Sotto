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

Leave PATH as supplied by Sotto's existing Hermes environment filter for the
version check, ACP viewer, gateway and Python readiness/profile helpers.
Hermes's absolute launcher and absolute helper interpreter still select its
private Python. The shared CLI lookup, other providers, Hermes's installation,
terminal configuration and shell profiles are unchanged.

## Native verification outside Sotto

Both runs used the installed Hermes 0.23.0, upstream `2bd378ed`, with fresh
temporary homes and Sotto's configuration. A bundled copy of Sotto's actual
`HermesAcpHost` started the gateway and ACP viewer. The before bundle read the
two launch modules from `87c33855a`; the after bundle read this change.

A loopback model server captured the system prompt, requested the real native
`terminal` tool with `command -v python3; python3 --version`, then returned a
final answer. Each run completed two model requests and settled idle. No Sotto
app instance or external model service was used.

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
probe. A separate direct call to its unchanged `_python_version_of('python3')`
and `_build_probe_line()`, using Sotto's before/after environments, confirmed:

| Evidence | Before | After |
| --- | --- | --- |
| Probe's `python3` path | Hermes `.venv/bin/python3` | `/usr/bin/python3` |
| Probe's Python version | `3.14.9` | `3.9.6` |
| Probe warning | `python3=3.14.9` | Empty: healthy toolchain |
| Native terminal | `/usr/bin/python3`, `Python 3.9.6` | `/usr/bin/python3`, `Python 3.9.6` |
| Hermes's own interpreter | `3.14.9` | `3.14.9` |

## Checks and build

The regression test discovers a private venv through the actual CLI lookup,
confirms that the shared PATH helper would prepend it, and checks the environments
passed to all four Hermes launch paths. It also checks that the readiness and
profile helpers still use the absolute private interpreter.

Passed with the repository's CI version, Node 24.22.1, in order:

- `npm run typecheck`
- `npm run lint`
- `npm exec -- vitest run tests/unit/main/hermes.test.ts` — 5 tests
- `npm exec -- vitest run tests/unit/main/hermesEnvironment.test.ts` — 1 test

The shell's Node 25 initially failed the shared jsdom cleanup because
`localStorage.clear` was unavailable. The supported Node 24 run passed without
changing that setup. No full suite, Playwright, e2e or Sotto app run was used.

The local build target is `0.1.43-owl.20261107.4` at
`release/mac-arm64/Sotto.app`. It follows the `.3` build's asset check, renderer
and main bundle, Core ML helper, key listener, build provenance and arm64
directory packaging, with the version supplied by electron-builder's
`extraMetadata.version` option. Source manifests stay at their existing version.
Packaging omits the app-launching verification commands and installation; the
completed bundle is checked through its manifest, signature and build provenance.
