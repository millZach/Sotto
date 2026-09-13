# Codex skills backend verification

September 12, 2026. Ticket #63 backend lane, based on `17c47b5`. Renderer and queue integration belong to separate Phase 2 lanes.

## Native evidence

- Installed `codex-cli 0.154.0`; generated protocol with `codex app-server generate-json-schema --experimental`. Relevant schema extracts and SHA-256 hashes are in `artifacts/skills-native/protocol-evidence.json`.
- The opt-in `tests/integration/codexSkillsNative.test.ts` exercised the production native host against the installed client, using an empty temporary Sotto metadata directory and the existing native account environment. It requested the actual lane cwd, first normally and then with forced refresh. Both returned 58 enabled skills, user/system scopes, and zero native catalog errors. No native thread or turn was created. `artifacts/skills-native/catalog-probe.json` contains the sanitized summary; no account identity, instructions, credentials, or private transcript is recorded.
- Official [App Server skills documentation](https://developers.openai.com/codex/app-server/#skills) establishes `skills/list`, `forceReload`, `skills/changed`, manual `$name` syntax, and recommended structured `{type: 'skill', name, path}` input alongside text. The installed schema supports these fields. It does not support every newer optional field shown in the current documentation; Sotto does not send extra roots or plugin-management requests.
- Official [skills documentation](https://developers.openai.com/codex/skills/) states that duplicate names may both appear in selectors and disabling implicit invocation still permits explicit invocation. The installed `SkillMetadata` exposes `enabled`, but no separate user-invocable field. Sotto preserves native order, duplicate names, descriptions, scopes and paths, filters disabled entries, and does not infer a separate filesystem policy or impose scope precedence.
- Pinned T3 reference `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`: `apps/server/src/provider/Layers/CodexProvider.ts` `parseCodexSkillsListResponse`, `probeCodexAppServerProvider`, and `probeCodexSkillsForCwd` use native cwd-scoped discovery. Sotto requires the matching cwd entry instead of T3's fallback that flattens other cwd entries. T3 `CodexSessionRuntime.ts` `buildTurnStartParams` sends text and images; Sotto's structured skill input comes from the installed schema and official documentation, not an assumed T3 implementation. `apps/web/src/components/chat/ComposerCommandMenu.tsx` distinguishes skills from slash commands and displays skill source.

## Implemented boundary

`refresh-thread-skills` is a read-only control fast path. It does not select a thread, change a draft, create an assignment, record a coordinator turn, or persist the catalog. Per-thread request revisions prevent older responses from replacing newer results. The host wrapper translates Sotto identity; the composite uses the thread's provider, independently of the coordinator. Catalog errors remain local to the picker and malformed catalogs do not disconnect active coding threads.

The native adapter passes its durable alias cwd to `skills/list`, verifies that folder exists, and never accepts a replacement scope for an existing alias. It invalidates catalog knowledge on native skill/account notifications and disconnect. A picker must request on each opening; explicit Refresh forces reload. Selected references are checked against a fresh native catalog before dispatch. Missing tokens, disabled/removed references, and fabricated paths fail before `turn/start`. Plain manual text without selected references bypasses catalog discovery. The same `prepareSkillInput` helper is available to the queue lane's native steer implementation. Existing uncertain delivery and origin reconciliation remain in place; no mutation retry was added.

## Checks and integration limits

- Focused tests cover native parsing, exact references through the fixture process, refresh failures, late response ordering, unchanged focus/draft/assignment, alias cwd after restart, unstarted local routing without native creation, and rejecting a selected Codex skill after switching a local thread to another provider.
- Existing Codex-host, workspace and provider-switch regression tests run with `--maxWorkers=2`. Node/web TypeScript and focused ESLint checks pass. Final test count is recorded in the lane result report.
- The existing uncertain-settings reconnect test hit its 100 ms `initialize` deadline under concurrent load. Temporary method-only diagnostics identified startup; diagnostics were removed. Its fixture now uses a 500 ms request timeout and a 1,500 ms injected settings delay, retaining the original uncertainty assertion without requiring sub-100 ms process startup. Production deadlines are unchanged.
- The first late-response test used the fixture request log as a synchronization barrier before the fake consumed its script; that fixture race was corrected by waiting for script consumption. No production workaround was introduced.
- Parent must combine queue-owned `skills` propagation across draft revisions, digests, outbox, queued entries and dispatch; composer UI owns durable renderer draft references and picker/send behavior.
- Parent must replace the marked `project.path` argument in `WorkspaceHost.listThreadSkills` with the worktrees lane's `resolveThreadWorkingDirectory(thread, project)` for an unstarted thread. Existing native aliases already override any supplied scope. Pending/error worktree setup must fail without project fallback. This cross-lane dependency is not claimed complete in this checkout.
- Parent must test integrated Electron picker behavior, keyboard/send feedback, navigation/reload/restart durability, worktree scoping, and appearance. This backend lane changes no renderer or CSS and supplies no screenshots.
- A real model turn was deliberately not run concurrently. The fixture proves serialized native skill input and retained message identity, not actual model skill execution or rollout-origin behavior after a selected skill. Parent should include a benign selected skill in one coordinated bounded native verification turn if verifying those claims.

Read-only catalog probe command (PowerShell):

```powershell
$env:SOTTO_VERIFY_CODEX_SKILLS='1'
npm test -- tests/integration/codexSkillsNative.test.ts --maxWorkers=2
```
