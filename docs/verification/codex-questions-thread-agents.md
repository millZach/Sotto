# Codex questions and thread-owned Agents

September 23, 2026. Initial checkout: `11e60a67f5529a1eefad5be5bc5990ef069f5205`. This note covers local source and the locally built Windows Electron app, not an installed release or a paid native model turn.

## Report and causes

Zach showed actionable Codex questions appearing only in chat text and an Agents roster belonging to another thread. He confirmed questions should use the existing panel during work, and Agents must belong to the thread whose conversation is selected.

The installed Codex CLI is 0.156.1. `codex features list` reports `default_mode_request_user_input` as under development and false. Its generated experimental schema includes `item/tool/requestUserInput` and `isBlocking`. Sotto handled structured requests but did not enable that Default-mode feature. Ordinary message deltas do not create pending questions. The adapter now enables the feature in thread-local start/resume config, preserving browser config and effort. Guidance directs actionable questions into the tool. Sotto does not infer structured questions from arbitrary prose.

Agents previously used the shared Tools pin. The roster was correctly reading the pinned thread, but that contradicted the user's expectation. Agents now follows the focused thread. Browser, Terminal, Files and Changes retain their working-copy pin. The Agents footer and working indicators use the selected thread too, and its surface omits the irrelevant pin control.

## Reproduction

- `npx vitest run tests/unit/renderer/tools/toolsPanel.test.tsx -t 'shows only the selected' --maxWorkers=2` failed before the fix: after selecting the second thread, its `Review Previews` row was absent and the pinned thread's roster remained.
- `npx vitest run tests/integration/codexQuestionPopup.test.ts --maxWorkers=2` failed before the fix: expected one pending question, received zero. The fake native server exposes the structured request only when the Default-mode feature is enabled. After the fix the lead independently ran the expanded Codex/browser checks: 11 passed.

These tests establish Sotto's configuration and request routing. They do not demonstrate that a live model will always choose the tool. The installed protocol and feature catalog, the [App Server reference](https://learn.chatgpt.com/docs/app-server), and OpenAI's native `request_user_input_default_mode_forwards_non_blocking` test establish the supported protocol path. There is no native request named `request_user_input_async` in the installed generated protocol.

## Running app

The real Electron app used isolated synthetic E2E profiles. The lead ran and inspected:

- `tests/e2e/subagents.spec.ts`: selected-thread roster, another working copy pinned, close/reopen, return to Files, history and nested agents, disconnect, keyboard navigation, reduced motion, no horizontal overflow, and text contrast at 1600×1000, 1280×800 and 820×560 in dark and light.
- `tests/e2e/thread-sidebar-question.spec.ts`: question and permission indicators with the voice coordinator off/on, a pending question while the thread remains running, explicit answer submission, and question-panel captures at the same six size/appearance combinations with reduced motion.
- `tests/e2e/tools-sidecar.spec.ts`: all Tools surfaces at three window sizes and three panel widths, dark and light. All four Electron journeys passed against the final build: three Agents/question tests in 12.5 seconds and the broader Tools test in 2.7 minutes.

The first sidebar run failed because the tests looked up raw fixture IDs in the host-scoped client snapshot. The rendered sidebar already said Needs your answer. The test now uses the existing `hostEntityKey` mapping and passes; no production identity code changed.

Evidence in `artifacts/codex-questions-thread-agents/`:

- `agents-selected-docs-pinned-workshop.png`: Docs has no agents while Workshop's working copy remains pinned for other tools.
- `question-820-dark.png`, `question-1600-light.png` and the other four question captures: existing question panel while work continues.
- Final Agents size/appearance captures and `agents-visual-checks.json`: copied from the successful final run. Minimum measured text contrast is 7.76:1 in dark and 6.26:1 in light, exceeding 4.5:1.

## Review and gates

Fusion used one GPT-6-Sol sidekick at high effort for bounded reproduction, Tools implementation, lifecycle tests and gate execution. The lead owned behavioral decisions, native policy changes, prototype and integrated review. The prototype is archived on `prototype/codex-questions-thread-agents` at `6389af44e649c2c123f8bab25d8291c76835620a`; the implementation tree does not include it.

The lead caught and corrected the first Tools implementation removing folder-copy/reveal actions from Agents; those actions remain and address the selected thread. Independent standards review found that project `developerInstructions` would overwrite native configured instructions. The lead corrected this by reading the effective native field for the working directory and appending Sotto's guidance. The reviewer confirmed the correction, with no remaining material finding. Independent requirements review found no missing approved behavior, while noting the live-model limit above. Interruption/disconnect retain the existing empty-answer cancellation response; they never submit a selected answer or approval.

The native-instruction regression failed before the correction and passed afterward. An isolated config-only probe against installed Codex 0.156.1 verified that `config/read` with the synthetic project's working directory returns its effective developer instructions. No authentication or model turn was sent. Tests cover project creation and resume, rejected and malformed config responses, preserving the connection and retrying the same thread ID safely. The final focused Codex/browser suite passed 64 tests; the lead independently reran the final renderer suites, with 32 passing tests.

Final gates passed: `npm run typecheck`, `npm run lint`, `npm run notices:verify` (174 components), and `npm test -- --maxWorkers=2`. The full suite exited 0: 374 files passed and 19 skipped; 4,847 tests passed and 44 skipped, in 451.68 seconds. The first full run exposed two stale assertions that forbade all resume config; the updated assertions allow the question feature while continuing to forbid unconfirmed model, effort and permission replay. The corrected tree passed the final full run without source edits during it. The local log is `.cache/codex-questions-gates/test-final.log`.

Windows rendering was inspected; macOS and live model tool selection remain unverified. These results cover the local build; they do not establish installation or release of the fixes.

## Pull request verification

PR #280 integrated main's activity-snapshot optimization at `a15d3424`. The combined build and typecheck passed, as did 98 focused Codex, browser, Agents and activity-snapshot tests and all three Agents/question Electron journeys.

The first Windows CI run exposed a queue-answer test race: it observed the coordinator selecting Docs before the renderer committed its pending shell on the next animation frame. The test now waits for the visible draft-ownership notice before asserting the retained answer. This changes no product behavior or timeout. Hosted Bugbot and Greptile reviews could not run because their account usage limits were reached; the local two-axis review remains the review evidence.
