# The typecheck runs on TypeScript 7

## Status

Accepted October 26, 2026, at Zach's request, to make the typecheck faster. It changes development tooling only; the app Sotto ships is built and runs exactly as before.

## Context

`npm run typecheck` ran TypeScript 6.0.3's `tsc` over four projects (node, web, tests and tests.node). It is a gate on every pull request, on Windows and on Linux shard 1, and agents run it before every pull request on the development laptop.

TypeScript 7 is Microsoft's port of the compiler to Go. 7.0.2 became the `latest` tag of the `typescript` package on July 8, 2026, with native binaries for Windows x64, Apple silicon and Linux x64 shipped as optional dependencies. Its type checking is a structural port of 6.0's ([announcement](https://devblogs.microsoft.com/typescript/?p=5246)).

7.0 ships no JavaScript API: the package exports only a version and some `unstable/` entry points, and Microsoft says the new API arrives in 7.1 and will differ from the old one. typescript-eslint's type-aware rules, `ts-api-utils`, `scripts/verify-linux-shutdown-drain.mjs` and `tests/integration/headlessProcess.test.ts` all import `typescript` and need 6.0's API. Theo's tsc-rs was ruled out first: it has no Windows build and its code is unreviewed.

Measured on the Windows development laptop at `8dcac6902`, with nothing else running, median of three runs each:

| Project | 6.0.3 | 7.0.2 |
| --- | --- | --- |
| node | 14.4 s | 3.3 s |
| web | 14.0 s | 1.7 s |
| tests | 25.3 s | 4.0 s |
| tests.node | 37.3 s | 6.4 s |
| All four | 90.6 s | 16.2 s |

Both versions list the same files in every project (3,022 in tests.node), 7.0.2 reports no error 6.0.3 does not, and it fails on a planted type error. Peak memory on tests.node fell from 3.36 GB to 3.18 GB. Before the change, CI's Typecheck step took 69 to 110 seconds on Windows and 82 to 109 seconds on Linux shard 1.

## Decision

**1. The typecheck runs TypeScript 7.** `@typescript/native` is an npm alias for `typescript@7.0.2`, the name Microsoft's announcement uses for running 6.0 and 7.0 side by side. `npm run typecheck` runs `node node_modules/@typescript/native/bin/tsc` over the same four projects with the same flags.

**2. `typescript` stays 6.0.3.** Everything that imports the compiler keeps the 6.0 API: lint, the two files above, and any editor pointed at the workspace's TypeScript. Microsoft's `@typescript/typescript6` package is a shim that depends on `typescript@^6`, so it would add a name without changing the compiler.

**3. The script names the binary by path.** Both packages declare a `tsc` bin, so which one `node_modules/.bin/tsc` (and `npx tsc`) runs depends on npm's link order. The script does not rely on it.

## Consequences

The typecheck is about five and a half times faster locally. CI's two Typecheck steps shrink by about the same share of their check time; install time does not change.

There are two compilers to keep current. Code that 6.0 accepts with `stableTypeOrdering` should check the same on 7.0, but a difference between them would show as lint (6.0) disagreeing with the typecheck (7.0); the typecheck is the gate that decides. 7.0 turns some old options into errors (`baseUrl`, `moduleResolution: node`, `esModuleInterop: false` among them) and defaults `types` to none. Sotto's tsconfigs use none of those options and every checked project names its `types`, so nothing changed for them; a new tsconfig has to do the same.

`typescript` can move to 7 and the alias can go once every caller of the compiler API works on TypeScript 7's: typescript-eslint and `ts-api-utils`, `createSourceFile` in `tests/integration/headlessProcess.test.ts` and `transpileModule` in `scripts/verify-linux-shutdown-drain.mjs`. Microsoft says 7.1's API will differ from 6.0's, so Sotto's own two need porting, not only a version bump. Until then, a `typescript` upgrade stays on 6.x.
