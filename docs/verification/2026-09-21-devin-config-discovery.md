# Devin reads `.devin` upwards, never downwards

2026-09-21. Windows 11, Devin CLI **3000.10.31 (b98cc431)**, the version ADR-0017 pins. Run against the installed native client at `%LOCALAPPDATA%\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe`, in a scratch tree under `%TEMP%`. No prompt was sent at any point, and the only session created anywhere in this work was the discovery one the adapter deletes, so no model ran and no credits were spent.

## Why this was measured

`assertDevinWorkingDirectory` refused native `.devin` configuration in the working folder's ancestors **and** in every directory below it. Walking the descendants is what forced the 25,000-directory and 250,000-entry bounds, and the refusal they produce: "This working folder is too large to check for native Devin configuration."

The descendant half rested on an assertion in the source — that native settings can be discovered lazily below the working folder — which neither ADR-0017 nor [the policy note](2026-09-19-devin-policy.md) recorded an observation for. This experiment tests it.

## Method

A scratch tree with the same file at two depths:

```
%TEMP%\devin-scan-probe\
  .devin\mcp_config.json          -> server "probe-at-cwd"
  sub\
    deep\
      .devin\mcp_config.json      -> server "probe-in-descendant"
      .devin\rules\probe-rule.md
```

`devin mcp list` reports the MCP servers the CLI has resolved for the current directory without starting the agent, so it reads the same project configuration a session would, at no cost. `mcp_config.json` is one of the five files the gate checks.

## Result

| Run from | `probe-at-cwd` (at the root) | `probe-in-descendant` (in `sub\deep`) |
|---|---|---|
| `devin-scan-probe` | listed | **not listed** |
| `devin-scan-probe\sub` | listed | **not listed** |
| `devin-scan-probe\sub\deep` | listed | listed |

Reading down the first column: the root's configuration is found from the root and from both directories beneath it, so **ancestors are read**. Reading across the last row: the descendant file is found only once that directory *is* the working folder. **Descendants are never read.**

The last row is also the control. It rules out the alternative explanation — that `probe-in-descendant` was ignored because the file was malformed — since the identical file is honoured the moment its own directory becomes the cwd.

Two supporting observations:

- **The detector is sensitive.** A deliberately malformed config passed through `--config` produced `Warning: Could not load config file …: Failed to parse JSONC … Using default settings.` A malformed `.devin/config.json` at the working folder produced no such warning from `mcp list`, so absence of an effect is observable rather than merely unremarked.
- **Rules behave the same way.** `devin rules paths` reports `.windsurf/rules/*.md` and `.cursor/rules/*.md` resolved against the current directory, and `probe-rule.md` in a descendant `.devin/rules/` never appeared in `devin rules list`.

## What this establishes, and what it does not

Established for the pinned CLI on Windows: the CLI resolves the `.devin` directory from the working folder upwards, so `mcp_config.json` below the working folder cannot reach the session Sotto starts and one at or above it can. The measurement is of that directory resolution, which the five gated files share; only `mcp_config.json` was observed taking effect, and the other four were not measured individually. The working folder and its ancestors are therefore the complete boundary, and a folder's size and its linked directories decide nothing about safety.

Not established: that project-level `.devin/config.json` is read at all. `mcp list` did not load one even at the working folder, and this experiment did not find a credit-free way to observe the merged permission set a session runs under. The gate keeps refusing that file at the working folder and above, which stays fail-closed on the unresolved half.

Not established: macOS behaviour, consistent with ADR-0017's existing Windows-only scope.

## What changed

The descendant walk, both traversal bounds, the "too large" refusal and the "linked directories" refusal are removed. `assertDevinWorkingDirectory` now checks the working folder and its ancestors, which is a bounded number of `lstat` calls. `tests/unit/main/devinPolicy.test.ts` asserts the new boundary in both directions, using `mcp_config.json` because that is the file measured here. `tests/integration/devinPolicyBoundary.test.ts` pins the folder the catalog session is given, that the checks still refuse when that folder itself carries native configuration, and that a refused reconnect keeps the threads Sotto already had.

## The second finding: connecting never had a project

The refusal reproduced on this machine because `DevinAcpHost.connect` passed Sotto's own user-data directory as the discovery session's working folder. That folder holds `thread-worktrees\`, one checkout per thread: 52,247 directories and 594,671 entries here, against a 25,000-directory bound. Connecting failed on Sotto's own storage, and would fail on any installation that has used worktree-backed threads, since that folder only grows.

Connect has no project to check — the catalog session exists only to read the model list and is deleted immediately. It now runs in `<userData>/devin/catalog`, a folder Sotto creates and never writes to, so the compatibility checks pass on their own terms and connecting costs the same whatever the user's threads contain.

Checked against the installed CLI through the real adapter, with a `thread-worktrees\thread\.devin\mcp_config.json` planted in the data directory to stand in for the failing installation. `DevinAcpHost.connect` returned `connected: true`, no error, version `3000.10.31 / ACP 1`, and the account's full model catalog. Before the change the same shape refused. No session was created beyond the discovery one the adapter deletes, and no prompt was sent.

## Also observed

With the Sotto profile applied, `devin --config <profile> mcp list` reported this machine's globally enabled `blender` server as `✗ blender  (disabled)`, and `plugins list` reported `No plugins installed.` Both are the exact shapes `verifyDevinMcpList` and `verifyDevinPluginList` accept, so the owned profile suppresses a natively enabled MCP server rather than the user having to disable it by hand.
