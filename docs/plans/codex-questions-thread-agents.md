# Codex questions and thread-owned Agents

User-approved behavior, September 23, 2026:

- Actionable Codex clarification questions use the existing question panel, including while the agent continues working.
- Opening Agents from a thread shows only agents spawned in that thread. Another working copy's Tools pin must not redirect the roster.
- Keep the existing visual design and permission boundaries. Only the user submits a selected answer; interruption and disconnect retain the existing empty-answer cancellation response.

Fusion execution: GPT-6-Sol at high effort handles bounded reproduction, implementation and test work. The lead owns diagnosis, behavioral decisions, prototype and integrated review. The initial checkout was clean at `11e60a67f5529a1eefad5be5bc5990ef069f5205`.

## Acceptance and progress

- [x] Reproduce the Codex question capability/routing gap at the native adapter seam.
- [x] Reproduce Agents showing a pinned thread's roster after selecting another thread.
- [x] Prototype the approved behavior using the existing layout: Agents follows selection, other tools retain their working-copy pin, questions stay with their thread.
- [x] Implement minimal fixes and cover the original symptoms and neighboring behavior.
- [x] Run typecheck, lint, notices, the full two-worker suite and relevant Electron journeys.
- [x] Inspect dark/light and reduced-motion rendering at 1600×1000, 1280×800 and 820×560; record evidence and actual limitations.
- [x] Review standards and user requirements against the initial revision.

The reproduction and verification evidence is recorded in `docs/verification/codex-questions-thread-agents.md`. After local verification, Zach authorized committing, opening a pull request, monitoring its checks and review, and merging once green. Release and installation remain outside this task.

The throwaway behavior prototype is archived on local branch `prototype/codex-questions-thread-agents` at `6389af44e649c2c123f8bab25d8291c76835620a`, path `src/renderer/src/tools/thread-tools-prototype.html`. The lead rendered it with local Edge and inspected the pinned Workshop / selected PLC conversion case. The verdict follows the user's explicit clarification: Agents belongs to the selected conversation. The prototype is kept off the implementation branch.
