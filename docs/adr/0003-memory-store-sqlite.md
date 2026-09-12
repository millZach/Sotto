# 3. Local memory storage with Electron's built-in SQLite

## Status

Accepted — 2026-09-10 (Windows x64 verified; Mac arm64 deferred)

Amended 2026-09-11 by ticket #16: E2E opens the store in its isolated profile, questionnaire and inspector provenance are valid sources, and the profile service implements supersession. These replace the original M0 deferrals so the actual user journey can be tested without accessing production memory.

## Context

The memory-first prototype (spec v0.2, sections 5.2, 5.3 and M0) needs durable local memory, temporal metadata and full-text retrieval in the Windows x64 distribution. Production dependencies must remain exactly `['zod']`. A separate native SQLite addon would introduce Electron ABI rebuilds, architecture-specific binaries, packaging rules and license inventory work.

The ticket's prior runtime probe established that Electron 43.1.0 ships Node 24.18.0 with `node:sqlite` and FTS5 enabled. This worktree's system Node 24.14.1 also supports that module; the shared migration and full-text probe passes there with SQLite 3.51.2. The installed `@types/node` 26.1.1 already declares the members used, so no ambient shim is required.

## Decision

**Use `node:sqlite` and `DatabaseSync`.** During `createRuntime`, `src/main/index.ts` opens `join(app.getPath('userData'), 'memory.sqlite')` through `openRuntimeMemory`. Development E2E runs open the same store in their isolated user-data profile. An open failure logs the stable operational event `memory-store-open-failed` and startup continues without memory. The main process closes the store on `will-quit`, alongside its other disposals. Opening creates parent directories, enables WAL and foreign keys, and records each schema migration with an ISO 8601 UTC timestamp. Each pending migration runs in its own transaction, with its version check inside the write transaction. Failed migrations roll back and opening releases the connection on failure.

**Keep one structured memory table and an external-content FTS5 index.** Migration 1 stores the section 5.2 metadata, JSON provenance and tags, ISO 8601 UTC temporal fields, and nullable embedding bytes. `lastConfirmedAt` and `lastUsedAt` are nullable in SQL and Zod so inferred, never-used memories need no invented timestamps. Thread provenance contains `{ threadId, ref }`, where `threadId` is a Sotto thread ID. Questionnaire answers and inspector corrections instead contain `{ source, ref, recordedAt }`; these explicit non-thread sources do not invent a thread ID. Provider session IDs remain in provider adapters and the thread registry; later features resolve the thread binding there. Insert, update and delete triggers maintain the lexical index transactionally. Zod validates the public memory shape. `search(query, { limit, projectId?, at? })` quotes user terms, uses bound parameters, ANDs terms and ranks by ascending `bm25`. It includes active and temporary rows where `validFrom <= at` and `validTo` is null or greater than `at`; `at` defaults to the current ISO timestamp. A `projectId` filter means exact equality with `scope`: project-scoped records store the project id in that column. `get()` retains access to history. The profile service now uses `validTo`, `supersededBy` and `state` for immutable edit/supersede history. Its validated command interface performs replacements and complete-chain deletions transactionally. Authority is metadata here; this store does not grant permissions or implement dispatch policy.

**Defer sqlite-vec; use in-process vector scoring for the alpha.** Reserve `embedding BLOB NULL` now. The later hybrid retriever will decode those bytes and score a narrowed candidate set in process; this ticket implements lexical retrieval and byte persistence, not embedding generation or a semantic retrieval API. Revisit sqlite-vec when candidate sets exceed about 50,000 rows or measured p95 retrieval exceeds the spec's 100 ms budget. Adopting it would require enabling `allowExtension`, loading a trusted architecture-specific `.dll` on Windows or `.dylib` on macOS, adding packaged resources and missing-resource checks, verifying macOS signing/loading behavior, and adding its license attribution to the notices inventory.

**Package no additional native resources.** The packaged Electron runtime provides SQLite and FTS5. There is no new native addon, loadable extension, rebuild step or production dependency. A Node builtin needs no new `THIRD_PARTY_NOTICES.md` entry: Electron and its shipped license files already cover it. `migrations.mjs` and its sibling `.d.mts` share executable migration SQL and an INSERT statement derived from one column list between the TypeScript store and the direct Node probe. The main entry imports the store and probe, so electron-vite/Rollup bundles their local modules and SQL into the packaged main graph. `scripts/release-external-dependencies.mjs` explicitly allows `node:sqlite`; the verified Rollup inventory contains only that spelling, so no bare `sqlite` entry is needed. Production dependencies remain exactly `['zod']`. Verification uses module inventories and behavior, never generated chunk names.

**Probe the packaged main process before the normal launch smoke.** `verifyPackagedMemoryStore` in `scripts/verify-packaged-resources.mjs` launches `profile.executablePath(target)` with Playwright, following the normal launch smoke's platform environment and Chromium profile isolation. It removes `ELECTRON_RUN_AS_NODE` and sets `SOTTO_MEMORY_PROBE=1` and `SOTTO_MEMORY_PROBE_USER_DATA` to a directory under an OS temporary root. At startup, this mode selects that user-data directory before any legacy-data migration and bypasses the normal runtime/E2E bootstrap. After Playwright attaches stdout and exit listeners, a quit request invokes the one-shot `before-quit` handler to run the probe; no renderer bridge is exposed. A 60-second deadline prevents an unattended probe from waiting forever.

The bundled probe opens the real `MemoryStore`, applies every migration (currently 1 through 3; migration 2 adds the policy table, see ADR-0004, and migration 3 stores questionnaire completion), inserts one memory with nullable confirmation/use timestamps and Sotto thread provenance, and calls `MemoryStore.search` for an FTS5 match. It reads the actual migration record and SQLite version, closes the store, prints one JSON line `{ sqliteVersion, migrationVersion, matchedId, fts5 }` and exits 0. The verifier requires both a successful process exit and complete, correct JSON evidence; missing bundled store code/SQL, missing runtime capabilities, process failure, timeout or malformed output fail verification. Diagnostics include output tails. The result is returned as `memoryStore`, and the isolated profile is removed after the process closes. No checkout SQL or script supplies this packaged evidence, and there is no separate store binary to inventory.

**Retain a direct runtime check.** `scripts/probe-memory-store.mjs` still runs under `ELECTRON_RUN_AS_NODE=1` for the documented Mac check below. It uses checkout migration SQL and the shared INSERT statement in an OS temporary directory, checks FTS5, closes and reopens the database, and verifies that the second connection applies no migrations. It prints the same evidence shape. This check is supplemental; the packaged-resource verifier depends on the bundled main-process probe.

**macOS arm64 verification is explicitly deferred.** The same platform-profile probe path is implemented but has not been exercised on a Mac. On the Apple silicon Mac, from the repository root, run:

```sh
npm run package:dir:mac
```

That command includes the packaged-resource verifier and therefore the memory probe. For the direct runtime check, run:

```sh
ELECTRON_RUN_AS_NODE=1 release/mac-arm64/Sotto.app/Contents/MacOS/Sotto scripts/probe-memory-store.mjs
```

## Consequences

- SQLite/FTS5 availability follows the Electron runtime. Upgrades must pass the probe rather than relying on a system-Node test alone. `node:sqlite` currently emits an experimental-feature warning under system Node; successful probe evidence is written separately to stdout.
- Synchronous database work is acceptable for the small alpha store. Large scans must be bounded and timed by the future retriever; measured latency can justify moving work off the main thread or adopting a vector extension.
- WAL creates adjacent `-wal` and `-shm` files. Backups and future deletion/export flows must account for an open database; tests and the probe close connections before deleting their temporary directory.
- The packaged probe verifies the store and SQL in the shipped main-process graph. Semantic retrieval remains follow-on memory work; ticket #16 implements temporal supersession.
- Windows x64 verification passed in this worktree with `npm run package:dir` on 2026-09-10. The packaged main-process probe reported SQLite 3.53.1, migration 1, matched ID `memory-probe` and FTS5 true; the normal packaged launch smoke also passed. Mac arm64 remains deferred. The integrated branch passed the same check from the main checkout.
- Migration 2 adds the policies table under ADR-0004 and changes the expected packaged probe evidence to migration 2. Windows x64 verification with `npm run package:dir` passed again on 2026-09-10 with that evidence (SQLite 3.53.1, migration 2, FTS5 true).
