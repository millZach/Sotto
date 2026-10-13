# Provider marks on sidebar rows, and first-message titles — 2026-10-05

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

Two complaints about the Threads sidebar. Each row's second line named its provider in words ("Codex", "Claude Code"), and the user wanted the company's logo there instead. A new thread also stayed "New thread" for a long time, and Codex threads seemed almost never to be named.

## The sidebar row

The provider's mark now stands where its name was, in the provider's colour, as Personal chats already draw it. Hovering the mark names the provider and the model. A wide sidebar still shows the model's name beside the mark, and the status stays on the right. A screen reader still hears the provider's name, which the status line already carried. The user chose this from three variants in an HTML prototype (coloured mark, muted mark, mark on a tinted chip). The prototype is kept on the branch `prototype/sidebar-provider-logos`, not in `main`.

## Why names were slow, and why Codex seemed not to get one

A thread asks for its generated title only after its whole first turn ends, which for a coding agent can be minutes. The side call itself then starts the thread's own client cold: `codex exec` took 15.8 s to name a thread when run by hand, 11.5 s of that before the turn began.

The local records showed no Codex-only failure. Of the 26 Codex threads with a name the user set, 24 were named in the New thread dialog when they were made. Since generated titles reached Codex, 16 of 17 Codex threads made without a name got a generated one. The one exception ran its first turn while Keep local history was off, when nothing is named by design.

One real gap turned up. Automatic naming refused any thread with more than one user message, so a steer or a queued follow-up sent during the first turn left the thread on its stand-in name for good.

## What changed

- A thread Sotto saw begin, empty and on a `default` name, takes the opening words of its first message as its name the moment that message arrives (a first-message title, `CONTEXT.md`). Nothing is asked of any provider for it. The generated title replaces it when it lands.
- A thread that began with a first-message title is still named after a steer or a follow-up sent during its first turn.
- An older or imported thread, one that already had history when this run first saw it, is not renamed.
- A first-message title keeps `titleSource: 'default'` on the wire and is marked by the new optional `titledFromFirstMessage` field. Host protocol v1 allows new optional fields but not new values in an existing enum, so an older desktop still reads a newer host's threads.
- Both follow Generated thread titles and Keep local history, as before.

## Automated checks

- `tests/unit/main/threadTitles.test.ts`: the cut (whitespace, a last word that fits, a long unbroken run, an emoji at the cut); a first-message title while the turn runs, kept against the provider's own name, then replaced by the generated one; a steered first turn still named across a restart; an older thread left alone; generation off; history off.
- `tests/integration/socketClientIsolation.test.ts`: the finished-unread test found its thread by the title "Workshop", which its first message now changes. It finds the thread by ID after the first lookup.
- `tests/e2e/thread-sidebar-resize.spec.ts` checks the row's mark and its hover name in place of the provider's text, and passes against the built app.

The thread-creating specs that touch this area pass, except eight tests in `crossing`, `devin-provider`, `phase-one-integrated` and `provider-recovery` that fail the same way when built from `origin/main` (1594b4a5).

## Design captures

`npm run design:verify` stops on this machine at `onboarding-step-2-microphone-ready.png`, a screen this change does not touch, before it reaches the thread captures. The baselines were regenerated with `npm run design:capture`, and only those this change explains were kept: the fourteen `threads-*` captures that show thread rows (the provider's word becomes its mark, about 1,200 changed pixels each) and `settings-cleanup.png` (the Generated thread titles description is one line longer). The other 34 images the run rewrote, which differ from `main`'s baselines for reasons outside this change, were restored. `node scripts/verify-design-captures.mjs` verifies all 146 tuples.
