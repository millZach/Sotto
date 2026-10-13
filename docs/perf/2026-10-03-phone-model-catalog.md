# A paired phone's shell without the model catalog - October 3, 2026

Issue #699. Every shell the socket listener sent a client carried the whole model catalog in `host.models`. On
the owner's install that was 753 models, 765 KB of a 1.1 MB shell, written again on every 50 ms publish while a
thread worked and decoded again by the iPhone each time. ADR-0028 had already stopped the desktop's own windows
being sent a catalog they held, and left the socket protocol alone.

Now a client that accepts the `model-catalog-revision` host feature is told the catalog's revision in every
shell (`host.modelsRevision`) and sent the catalog only when its connection has not yet carried that revision
whole. The listener counts revisions with `ModelCatalogRevisions`, the counter and content comparison the window
broadcast already used. The iPhone puts the catalog back in `HostConnection` before anything reads the shell.
Every other client is sent the catalog whole, as before. ADR-0028 has the amendment and `docs/host-protocol.md`
the rule.

## Numbers

`tests/perf/socketCatalogRevision.perf.test.ts` starts the headless host over the fixture providers and a socket
listener whose shell lists 753 synthetic models (`tests/fixtures/modelCatalog.ts`), 685,389 bytes serialized,
copied afresh on every read as the coordinator's shell is. Two raw peers share one session the way the iPhone
speaks the wire: one accepts the feature and one does not, which is every phone before it. Twenty publishes go
to both, and the sizes are of the shell frames as they arrived. The synthetic catalog is smaller than the
owner's 765 KB, so read the bytes against it rather than the issue's figure. It reads only byte counts and
durations.

Three runs on the development machine (Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1), from `origin/main`
at `e5686a97`. Other agents' suites were running on it, so read the times as sizes rather than budgets. The
timed rows are medians of 40 after 5 warm-up runs.

| What was measured | Whole catalog | Named by revision |
| --- | ---: | ---: |
| One repeat shell push, bytes | 692,553 | 7,173 |
| Listener: serializing that frame | 1.4-2.3 ms | 0.011-0.019 ms |
| Listener: comparing the catalog with the revision's | none | 1.5-1.9 ms |

- **One repeat shell push** fell by 99.0%. The byte counts were the same in all three runs. The first shell after
  a change, and every hello, carries the catalog whole plus about 20 bytes for the revision.
- **Comparing the catalog** is the listener's new work for each client that accepts the feature: the shell's
  catalog is a fresh copy every time, so the comparison is by content, `isDeepStrictEqual` over 753 models. It
  costs about what serializing the catalog into the frame used to cost, so the listener does about the same work
  per publish as before. The saving is the 685 KB the frame no longer carries over Tailscale and the phone no
  longer decodes.

## What was not measured here

The iPhone's own decoding is not in these numbers: Swift cannot be built on the development machine. Before the
change the phone decoded 753 models in every shell push; after it, it decodes them only in the frame that carries
a revision whole, and copies the held array into each shell that names it. A reply that carries the catalog is
decoded twice, once with its envelope so the connection holds it in socket order and once by its caller; a push
that carries it is decoded once. Nothing a user sees changes. It takes effect with an iPhone build
that asks for the feature.

## Tests

- `tests/integration/socketHostFeatures.test.ts`, `model catalog revisions (#699)`: an accepting client is sent the
  catalog once and then only its revision in pushes, a `shell` read and a command's answer; a changed catalog
  goes whole once under a new revision; a fresh connection's hello carries it whole; a client that did not accept
  the feature is sent it whole every time; a revision whose frame was replaced by `too_large` is not recorded as
  sent; and the desktop's own client still reads the whole catalog from a host that offers the feature.
- `apps/ios/Tests/SottoCoreTests/ModelCatalogTests.swift`: the iPhone puts the held catalog back into a shell or
  a hello that names its revision, refuses to show one that names a revision it does not hold, keeps the newest
  catalog, reads a shell from a host without the feature as it came, and reads a reply's catalog with its
  envelope.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/socketCatalogRevision.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It prints one `socket catalog revision:` line of JSON with the sizes in bytes and the medians in milliseconds.
Without `SOTTO_PERF_BENCH=1` it is skipped, like every benchmark that only reports timings.
