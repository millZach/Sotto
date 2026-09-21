# New thread setup

Zach chose prototype A (Direct choices) on September 20, 2026. The reference is `src/renderer/src/agents/new-thread.prototype.html` on the archived `prototype/new-thread-setup` branch; the production change preserves Sotto's Figtree, theme roles and quiet dialog.

## Acceptance

- One Working copy group: Project folder, New worktree, Existing worktree. Preserve saved overrides; reuse never creates a folder.
- One Start from picker identifies local versus origin branches. No duplicate worktree choice or origin checkbox. Preserve the existing current-branch policy. Explain uncommitted edits and first-send setup.
- Collapse thread options behind the selected model, reasoning and permissions. Preserve explicit choices through failed creation. Focus starts at the working-copy choice; Escape closes the dialog.
- Keep Create thread visible at 1600x1000, 1280x800 and 820x560. Review dark/light/reduced motion, contrast and wrapping. All colors use theme tokens.
- Move project defaults beside the global working-copy setting in Settings > Application; keep all saved overrides editable.
- September 21: Zach chose always inheriting Agents. Ignore the retired Grok thread override, remove competing controls, retain explicit per-thread and retry choices, and wait for unavailable inherited models.
- Run focused regressions, Electron journeys, typecheck, lint, full tests with two workers and notices verification. Record actual results and screenshots.

## State and design

A and agent inheritance are implemented and verified locally. Eight Electron journeys and 4,213 unit/integration tests passed, followed by focused checks for the late terminal and folder-registration fixes. Typecheck, lint, notices and the final build passed. The agent-default decision is resolved: inherit Agents. No live preferences were rewritten. Working-copy choice leads, source or existing folder appears conditionally, and optional thread settings follow. Visible copy consists of title, project identity, operating labels and state feedback. No decorative copy or added looping motion. Existing app styling is the rendered reference. Local artifact link support is a separate diagnosed limitation and is outside this change.

The three-variant reference and Zach’s selection are archived on local branch `prototype/new-thread-setup`. The implementation remains on the current working branch.
