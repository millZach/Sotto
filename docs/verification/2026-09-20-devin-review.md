# Devin two-axis review

September 20, 2026. Zach approved Codex reviewers instead of the configured Claude reviewer. Two independent read-only reviewers examined baseline a1466a79 through 7b5106fd. Follow-up reviews inspected the fixes. Mac verification was explicitly deferred by Zach; native provider analytics were explicitly accepted with disclosure.

## Standards

One confirmed P2: Devin's complete native replay contradicted ADR-0016's resume-without-re-reading and incremental reconnect-cost guarantees, and the user guide made an unqualified performance promise. The reviewer found no additional material smell findings.

Resolved: ADR-0016 now explicitly records the bounded Devin replay exception. The event store remains the history of record and renderer reads remain windowed. Native reads are bounded to 16 MiB/20,000 messages; idle polling is throttled, and excess history produces safe refusal. ADR-0017 links the amendment and the user guide states the native performance limitation. The Standards reviewer confirmed the documentation finding resolved.

## Spec

Two confirmed P2 findings:

- Spec section 11 requires determining whether work stops or survives ACP process exit. The original native test only restarted after completion and explicitly cancelled a permission. Resolved with native abrupt-exit checks for both an unsaved first owner and an owner resumed after a clean save. The results and limits are in the native compatibility note; no claim is made about arbitrary external child tools.
- Working-copy coverage required invalid bindings and the user stories required existing/new worktrees and first-send creation. Devin had an inert host at the existing native seam. Resolved by four passing cases using the real Devin fixture: shared folder, independent first-send creation, existing-worktree reuse after restart, and locked binding refusal preserving files and avoiding dispatch.

The Spec reviewer found no scope creep. Follow-up review confirmed the working-copy coverage and required final model validation, no model substitution, and accurately scoped native process-loss evidence.

## Additional fixes during verification

A signed-out empty catalog previously lost its sign-in guidance inside generic RPC validation. The compatibility message also omitted the supported version. Two red regression tests now pass with actionable login/version instructions. The abrupt-exit test exposed the same error-handling issue for a native model mismatch; final model comparison now occurs after parsing, preserving the safe refusal and recovery instructions. The replay message-count check now refuses at its intended bound. Temporary debug instrumentation was removed.

Standards: 1 finding resolved. Spec: 2 findings resolved, with the native platform check limited to Windows as authorized.

Final reviewed-source validation: typecheck, lint, and notices pass; 3,927 tests pass with 34 skipped (343.29 seconds). The built Electron journeys pass 2 tests (14.8 seconds); native Windows passes all 3 cases (54.10 seconds). Logs are under artifacts/devin-local-provider/final-reviewed-*.log.
