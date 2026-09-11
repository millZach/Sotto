# 3. Local memory storage with Electron's built-in SQLite

## Status

Proposed — 2026-09-10

## Context

The memory-first prototype (spec v0.2, sections 5.2, 5.3 and M0) needs durable local memory, temporal metadata and full-text retrieval in the Windows x64 distribution. Production dependencies must remain exactly `['zod']`. A separate native SQLite addon would introduce Electron ABI rebuilds, architecture-specific binaries, packaging rules and license inventory work.

The ticket's prior runtime probe established that Electron 43.1.0 ships Node 24.18.0 with `node:sqlite` and FTS5 enabled. This worktree's system Node 24.14.1 also supports that module; the shared migration and full-text probe passes there with SQLite 3.51.2. The installed `@types/node` 26.1.1 already declares the members used, so no ambient shim is required.

## Decision

**Use `node:sqlite` and `DatabaseSync`.** `MemoryStore` accepts a database file path; its future caller will supply `join(app.getPath('userData'), 'memory.sqlite')`. This ticket deliberately leaves the store out of `src/main/index.ts`. Opening creates parent directories, enables WAL and foreign keys, and records each schema migration with an ISO 8601 UTC timestamp. Each pending migration runs in its own transaction, with its version check inside the write transaction. Failed migrations roll back and opening releases the connection on failure.

**Keep one structured memory table and an external-content FTS5 index.** Migration 1 stores the section 5.2 metadata, JSON provenance and tags, ISO 8601 UTC temporal fields, and nullable embedding bytes. Insert, update and delete triggers maintain the lexical index transactionally. Zod validates the public memory shape. Search quotes user terms, uses bound parameters, ANDs terms and ranks by ascending `bm25`. Default search includes only active rows. A `projectId` filter means exact equality with `scope`: project-scoped records store the project id in that column. Supersession preserves the old row and sets its validity end, replacement id and state atomically. Authority is metadata here; this store does not grant permissions or implement dispatch policy.

**Defer sqlite-vec; use in-process vector scoring for the alpha.** Reserve `embedding BLOB NULL` now. The later hybrid retriever will decode those bytes and score a narrowed candidate set in process; this ticket implements lexical retrieval and byte persistence, not embedding generation or a semantic retrieval API. Revisit sqlite-vec when candidate sets exceed about 50,000 rows or measured p95 retrieval exceeds the spec's 100 ms budget. Adopting it would require enabling `allowExtension`, loading a trusted architecture-specific `.dll` on Windows or `.dylib` on macOS, adding packaged resources and missing-resource checks, verifying macOS signing/loading behavior, and adding its license attribution to the notices inventory.

**Package no additional native resources.** The packaged Electron runtime provides SQLite and FTS5. There is no new native addon, loadable extension, rebuild step, production dependency or separate `THIRD_PARTY_NOTICES.md` entry beyond Electron and its already shipped license files. `migrations.mjs` and its sibling `.d.mts` keep executable migration SQL shared between the TypeScript store and the plain Node probe. When a feature imports the store, electron-vite/Rollup bundles this local ESM module; `externalizeDepsPlugin` externalizes package dependencies, not local source modules. Until then the unused store is outside the app entry graph, so the external dependency inventory is unchanged.

**Probe the actual packaged executable before the normal launch smoke.** `scripts/verify-packaged-resources.mjs` uses `profile.executablePath(target)` on both supported platforms and runs the absolute `scripts/probe-memory-store.mjs` path with `ELECTRON_RUN_AS_NODE=1`, a 60-second timeout and a hidden Windows child process. The probe opens an isolated temporary file, applies the shared migration, inserts a memory, checks an FTS5 match and verifies reopening applies nothing. It prints one JSON line containing the SQLite version, applied migration version, matched id and FTS5 result. The verifier rejects process failure, missing runtime capabilities, timeout, malformed output or incorrect evidence, includes stdout/stderr tails on process failure, and returns the probe result as `memoryStore`. Missing runtime files that prevent the executable from starting therefore fail verification; there is no separate store binary to inventory.

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
- The probe validates the packaged runtime against source migration SQL, not a feature wired into the packaged main process. The user-data integration and semantic retrieval remain follow-on memory work.
- Windows packaged-build verification is reserved for the driver via `npm run package:dir`. This lane did not run electron-builder. The direct Electron probe could not run because this worktree's `node_modules/electron/dist/electron.exe` and `path.txt` are absent; no install was attempted through the shared `node_modules` junction. The ticket's earlier Electron probe is supporting evidence, not a claim that this lane exercised that runtime. Both the driver's packaged Windows check and the Mac check remain outstanding.
