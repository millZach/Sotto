# A phone's shell without the parts no phone reads - November 10, 2026

The November 10 audit (`2026-11-10-performance-and-data-audit.md`, finding 2) found that every shell a host sends a
phone carries the host's whole state, and that most of it is parts no phone reads. This is the first step of the fix
(#2392): a host leaves five parts out of a phone's shell. Sending the parts a phone does read only when they change is
the second (#2393).

## What went

`PHONE_UNREAD_SHELL_PARTS` in `src/shared/hostProtocol.ts`:

| Part | What it is | On forge's host, a push |
| --- | --- | ---: |
| `skillCatalogs` | Each thread's list of skills, for every thread whose list was read since the host started | 115,223 bytes |
| `obsoleteDrafts` | The drafts a send made obsolete, up to 128 | 12,929 bytes |
| `clientUpdates` | The provider clients' updates | 1,454 bytes |
| `threadDrafts` | Every thread's draft | 1,001 bytes |
| `threadDraftPersistence` | Whether each draft is saved | 827 bytes |

No iPhone or Android build has named any of the five (`git log -S` over `apps/ios` and `apps/android` finds none), and
each is optional in protocol version 1. The host takes them out of a hello, a `shell` read, a command's answer and every
push, last of all, after it has worked out the composer's draft for that phone from its own drafts. A desktop's shell
keeps every part.

A phone, for this, is a client the listener does not know as a desktop and whose hello accepted `activity-summaries`,
which every iPhone and Android build does and no desktop does. A desktop whose record a listener has lost is admitted
as a phone, and it reads `threadDraftPersistence` to know a draft was saved, so the listener's own view is not enough.

## The measure

`tests/perf/phoneShellParts.perf.test.ts` starts the real listeners over the fixture host, lays over its state the parts
around the threads in the sizes forge's host sent (`tests/fixtures/shellParts.ts`: twenty threads' skill lists, the
delivery and draft ledgers at their limit of 128, each read with the state's own schema), and weighs what a phone and a
desktop are sent:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/phoneShellParts.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Before is the same test with the one line that takes the parts out switched off. The sizes are the same on every run.

| To a phone | Before | After | |
| --- | ---: | ---: | ---: |
| A push | 201,518 bytes | 72,656 bytes | 64% less |
| A `shell` read | 206,425 bytes | 77,563 bytes | 62% less |
| A hello | 209,264 bytes | 80,402 bytes | 62% less |

A desktop's push is 201,648 bytes before and after.

The fixture's push is within 4% of the one read from forge's host on November 10 (209 KB, by
`scripts/perf-bench/phone-wire-probe.mjs`). On that host an iPhone on a working thread was sent 32 pushes in a minute,
6.69 MB; at these sizes that is about 2.3 MB. What is left of a push is `deliveries` (55 KB), `deliveredDrafts`
(13 KB) and the smaller parts a phone reads, none of which changed in any push the audit saw. Those are #2393's.

## The guards

- `tests/unit/shared/phoneShellParts.test.ts` holds every part of the state's schema to one of two lists: the parts a
  phone is sent, or `PHONE_UNREAD_SHELL_PARTS`. A new part fails it until it is put on one. It also fails if a part on
  the second list stops being optional, or if the iPhone's or the Android client's source names one.
- `tests/integration/socketPhoneStreaming.test.ts` checks, over the real listener, that a phone's hello, `shell` read
  and pushes hold none of the five and still hold the delivery ledgers; that every part they do hold, the ones the
  host's projections add among them, is on the list of what a phone is sent; that a desktop's hello holds all five; and
  that a client on the phone listener that did not accept `activity-summaries` keeps all five.

## On forge's host

The audit's probe read a push of about 209,000 bytes and a hello of 236,631 from forge's host on November 10. The five
parts were 131,434 bytes of each, so with them gone a push is about 77,500 bytes and a hello about 105,200: under the
80 KB and 110 KB #2392 asks for. That is worked out from the real push's parts, not read. The probe reads the real
thing once a host with this change runs on forge, and #2392 stays open until it has:

```sh
node scripts/perf-bench/phone-wire-probe.mjs --data ~/.sotto --list-seconds 60 --thread-seconds 60
```

