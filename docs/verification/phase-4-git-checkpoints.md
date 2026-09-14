# Phase 4 Git and checkpoints

Scope: #60 and #62, Windows Electron desktop (1280/1600 and minimum 820×560), light/dark, pointer and keyboard. Baseline d596d832.

The selected working copy is a review surface whose proof is inspecting exact changes and deliberately committing or rewinding completed work.

Concept alternatives: file-first with nearby actions (selected); commit-first with a message form; timeline-first with checkpoint history. Preserve existing file-first Sotto tools and reveal secondary actions on demand.

Reference inspected before UI edits: existing `artifacts/design/app-review/baseline/threads-split-workspace-dark.png`; T3 pinned d1d15c67 CodexAdapter rollback delegates to native thread/rollback, ClaudeAdapter reconstructs exact turn boundaries through SDK forkSession, GrokAdapter explicitly rejects native rollback. Preserve Sotto typography, accent, hairlines and transcript-led hierarchy.

Acceptance checklist:
- [x] Deliberate staged/unstaged file actions, editable commit, empty prevention; branches report detached/conflicts accurately and preserve dirty work.
- [x] Temp-repo checks cover normal commits, stale actions, dirty checkout and isolated worktrees.
- [x] Durable checkpoints associate exact thread/turn identities; review affected files before confirmation.
- [x] Native rollback and files coordinate, guard active/pending work, preserve unrelated edits and recover interrupted actions without duplicate rollback. Full Electron lifecycle also passed with a synthetic native provider.
- [x] Grok and unsupported installed native capabilities explain limitations; no file-only rewind claim.
- [x] Render action controls and checkpoint review in light/dark at desktop/minimum sizes; keyboard targets remain reachable, 14px meaningful controls and 12px secondary copy.
- [x] Existing palette and fonts retained; changes/diff remain focal. No new decorative imagery needed for a file-review tool.
- [x] Progressive disclosure is the signature interaction: open local Git actions, choose action, show completion after authoritative refresh; preserve reduced-motion baseline.
- [x] First-screen new text purposes limited to branch, Git actions, checkpoints; contextual status/instructions remain essential operating feedback. No duplicated facts or companion copy in rendered review.

Implementation: selected-worktree Git commands use exact paths and reviewed revision, serialize writes across shared canonical folders, preserve native Git's dirty-checkout protections, and refresh authoritative state after success. Staged and unstaged comparisons read the actual index. Root integration guards native active/pending work and outstanding reverts.

Checkpoints store immutable content-addressed file blobs and a durable journal outside the working copy. Each record binds Sotto thread/provider/session identity, exact before/after user-message IDs and before/after file hashes. Rewind requires latest matching native history and unchanged Git HEAD/index; file restoration checks touched files against recorded hashes and preserves unrelated later edits. Concurrent thread captures in a shared folder become unavailable rather than attributing each other's changes. Uncertain native results persist a hold and recovery only reads native history; it never repeats rollback. Corrupt journals fail closed across restarts. Symlinks, junctions, hard links, submodules and unsupported capture sizes produce an unavailable checkpoint. Capture bounds are 10,000 files, 64 MiB total and 8 MiB per file; a failed file capture does not block ordinary sending.

Verification so far:
- 24 focused tests passed across `checkpoints.test.ts` (8), `gitChangesTools.test.ts` (8), and `changesSurface.test.tsx` (8); node/web typecheck and scoped ESLint passed. The interrupted-capture review regression was added after the 23-test combined run; all 8 checkpoint tests passed again after its fix.
- Red→green regressions: unborn-index unstage after further edits; mutable native history arrays changing a checkpoint boundary; corrupt journal recovery silently dropping unresolved native effects; interrupted initial capture incorrectly attributing offline edits to the completed turn. Interrupted captures now remain inspectably unavailable, while completed checkpoints and uncertain reverts retain their recoverable associations.
- `scripts/inspect-phase4-git.mjs` drove real Electron preload/IPC/Git services against an owned temp repository: stage, editable commit, clean result and keyboard branch creation all passed. Saved captures at 1280, 1600 and 820×560 in dark/light live in `artifacts/phase-four-git`.
- Rendered inspection corrected Sidecar's overriding grid placement and constrained the open drawer at minimum height. Diff, file status and action hierarchy now remain in the selected working copy. Commit and branch forms scroll inside the tools surface at minimum size; keyboard focus brings hidden controls into view. New actionable labels use 14px and staging metadata 12px; existing Sotto palette/fonts/focus outlines retained. No new animation beyond progressive disclosure and existing reduced-motion handling.
- First-screen new text purposes: Git actions, Checkpoints, selected-file Stage/Unstage (3). Opening a form adds its necessary editable-field label and submit action; branch details are secondary and scroll with their controls. Checkpoint file names, before/after content, confirmation and recovery status are essential operating information. No decorative or repeated explanatory copy was added.
- Full Electron checkpoint test initially found a new-thread guard regression before Files had a thread binding. Root corrected `WorkspaceHost` to skip that lookup during initial create-thread. The rerun passed: real create/send/complete/checkpoint lifecycle, file-content inspection, disabled-until-confirmed revert, keyboard checkbox/Enter, exact same Sotto thread/provider after rewind, and unrelated later file preservation. Native effects alone use the explicit synthetic Codex fixture. Reviewed `checkpoint-review-{1280,1600,820}-{dark,light}.png`; minimum-height review scrolls its before/after and confirmation together, and every control remains keyboard reachable. The final review corrected singular file-count copy; final root build updates this minor copy in captures.

No remote Git operation or mutation of the user's working repository was performed by verification. Native Codex/Claude provider verification belongs to the root integration evidence; service callback tests are explicitly synthetic native effects.
