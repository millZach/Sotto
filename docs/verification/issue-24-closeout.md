# Issue 24: native-host closeout

September 14, 2026. Audited published `main` at `0e12b1c` against [ticket #24](https://github.com/millZach/Sotto/issues/24).

## Delivered implementation

The production host removal was already merged: `1b6d338` removed the intermediary adapter, host probe, pairing workflow, protocol tests and live connection configuration. The later native-delivery fixes through `cc41f66` are ancestors of current main. The September 12 report's unmerged-worktree statement has been corrected without relabeling its historical test counts as fresh results.

The current application exposes native Codex App Server, Claude Code stream-json and Grok Build ACP adapters. It has no selectable intermediary host, pairing token field, host endpoint setting, or executable host dependency. Shared schema/retirement tests reject retired configuration in current commands and safely recover old saved drafts without replaying actions.

The two superseded September 9 intermediary-host control-center documents were removed. Their originating review links to a pinned historical Git revision; current agent-control documentation describes native operation and durable per-thread draft recovery.

## Deliberately retained references

Retirement migration must recognize old saved provider IDs and purge the old credential slot. Historical bindings, migration tests and recovery evidence remain necessary to avoid losing saved work or sending it to another provider. They do not enable a runtime host.

The later approved theme, icon and compaction work uses independently inspected behavioral references and licensed source. Its license notices, source attribution, stable palette IDs and palette screenshots remain. Historical ADRs and the memory-first specification retain decision provenance; ADR-0007 already supersedes the old host architecture. Removing these would exceed the host-retirement scope and break attribution or compatibility.

A separate read-only audit confirmed no host-specific capture baselines remain and visually inspected the current Settings, Agents and Threads baselines. Files containing `t3-code` or `t3-chat` in their capture names are palette captures, not host workflows.

## Fresh verification

- Shared Codex, Claude and Grok adapter contract suites plus provider-retirement regressions: **52 passed, 2 skipped**. Both skips belong to the fake provider's unsupported transport/persistence seams; native adapter contract cases run.
- Actual Windows Threads create → send → READY reply → application restart passed for all three installed providers, using one bounded synthetic no-tools prompt per provider in isolated profiles. The test now explicitly configures the connected provider and selects a ready model from its catalog. It preserves the same Sotto thread ID and provider binding, exactly one authored message, no assignment and an empty project directory. [Current native UI evidence](issue-24-current-native-ui.md).
- Root inspected all three restored native Threads screens: provider/model controls, READY transcript, cleared composer and saved identity are visible and contained.
- Typecheck, lint, runtime-asset verification and third-party-notice verification passed. Production code and dependencies are unchanged from the already verified build at the baseline; no replacement runtime build was necessary.

The notice check initially caught a missing inventory entry for `@xterm/addon-webgl`, introduced in the preceding terminal change. Its installed MIT license is now included by the notice generator and inventory; verification passes for all 174 components, and the existing release-notice regression passes. This fixes the packaging notice omission without changing the renderer or dependency version.

Representative restored native captures are saved under [artifacts/issue-24-closeout](../../artifacts/issue-24-closeout/). Private account stores and unrelated native histories were not inspected.

This closes the native-host migration scope. It does not claim packaged/macOS acceptance, paid permission/tool execution, physical voice testing, or satisfaction of #18's latency budgets. The separate personal-chat physical test remains in #81. The unrelated older UI layout checks recorded in the terminal-display report are not part of this native-host acceptance run.
