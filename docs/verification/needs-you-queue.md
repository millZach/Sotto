# Needs you settles a short approval and a failure from the sidebar

October 25, 2026. Branch `feat/needs-you-queue`. Records [ADR-0135](../adr/0135-the-threads-sidebar-opens-on-needs-you.md) and [its plan](../plans/needs-you-queue.md), as Zach picked the combination of variants 3 and 7 (№11) in `docs/prototypes/thread-attention-prototype.html`, checked in the built app on macOS. An Owl feature first: with `needs-you-queue` off, every journey below the first is the sidebar as it stands today.

## What was run

`tests/e2e/needs-you-queue.spec.ts` launches the built app with the unpackaged E2E host and `SOTTO_OWL_FEATURES=needs-you-queue=1`. The provider reports a permission on **Workshop** ("Run the build?") and a failed turn on the docs thread, renamed **Tidy the docs index** after its first message. Everything between that host and the window is the real coordinator, host service and renderer.

- **The queue stands.** Under the search: **Needs you**, count 2, oldest just now. The permission leads (**Needs your approval**, the ask itself, **Deny** and **Allow**), the failure follows (**Needs attention**, "The last turn failed.", **Dismiss** and **Open**). No Dismiss all line stands, and no folder dots are drawn while the card stands. The host's shell carries both stamps: the request's `since` and the thread's `failureSince`, each a real moment.
- **Approving there approves it.** Pressing the queue's **Allow in Workshop** sends the one `answer` for that request's own ID; the provider's next state shows the thread with no requests, and the entry leaves the queue. Nothing was sent as a message.
- **Dismissing there sees it.** Pressing **Dismiss Needs attention on Tidy the docs index** sends `dismiss-failures` naming that thread's failure; the shell then carries `failureSeen: true` for it, and with nothing left waiting the card goes entirely.
- **Off means today.** Launched without the feature, the same permission raises no card, and the closed folder's dots stand as they do today.
- **Unit level.** The derivation (membership, blocking-then-oldest, the three shown, overflow counts, the whole fits-here matrix, delegated waits opening only, unstamped waits saying nothing), the card (phases, the unconfirmed hold with Check again, blocked words, single and bulk dismissal by failure name, off-means-today), the stamps (first showing, keeping, forgetting, changed-only reads, publishing without copying), and the coordinator carrying both stamps on the shell and the whole state: `threadFacts.test.tsx`, `needsYouQueue.test.tsx`, `requestWaits.test.ts`, `failuresSeen.test.ts`, `failuresSeenControl.test.ts`. The pane's and Watcher's cards answer through the same extracted send (`threadRequests.ts`), and their suites stand.

Both e2e journeys passed. `tests/e2e/needs-attention-seen.spec.ts` was run beside them: its Dismiss-all journey passes; its first journey fails at the same row click on untouched `origin/main` on this machine (the row's hover actions intercept Playwright's click since the folder peek landed), so it is recorded here as standing local behaviour, not this change's doing.

## Fit and contrast

At 1600x1000, 1280x800 and 820x560, in dark and light, with reduced motion on, the card clips nothing: its scroll width is within a pixel of its client width at every size, measured in the running app. Need is said by each entry's ring and its status words in the warning text token, the count and the Settled tag are filled badges, the buttons are the app's own, and every new colour reads a `--tt-*` token; `themeTokens.test.ts` holds the painted pairs at 4.5:1. With the feature off, `threads-populated`'s sidebar is the baseline's, Dismiss all and all: no design baseline changes in this change, since the captures run on stable. `npm run design:verify` does not pass on this machine even untouched — its window chrome renders cropped against every baseline — so the captures' verdict is CI's, where main stands green.

## Captures

In `artifacts/needs-you-queue/`:

- `queue-{1600x1000,1280x800,820x560}-{dark,light}.png`: the card with the approval leading and the failure under it, before either is settled.

## The suite around it

`npm run typecheck`, `npm run lint` and `npm run notices:verify` pass. Of the full `npm test` on this machine, the failures standing are not this change's: the release and host-build tests refuse this machine's Node (24.14, under their 24.22.1 floor), the Git worker timing tests fail the same way on untouched `origin/main` here, and the long thread-changes run passes alone and timed out only inside the parallel full run. Every test this change touches or adds passes, including the shared-snapshot and copy-site guards the first stamp design broke and the decorating design satisfies.
