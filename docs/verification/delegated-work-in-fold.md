# Delegated work in the Worked for fold verification

October 24, 2026. `feat/delegated-work-in-fold`, on an Apple silicon Mac with the built app (`npm run build`). It replaces the delegation cards under a reply with rows of **delegated work** (Drake's pick on October 23, 2026, variant 2 of `docs/prototypes/delegated-work-prototype.html`).

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/threadDelegation.test.tsx
npm test -- --maxWorkers=2
npm run build
npx playwright test tests/e2e/thread-delegation.spec.ts -g "delegates to a Codex thread"
```

## What was checked

`threadDelegation.test.tsx` draws the transcript with delegations of each kind, and tests the state, line and summary words for every state on their own:

- A turn with nothing else to fold shows its rows under its reply, before the next message. Each row has the kind of work as a mark and a word, the delegated thread as a link that opens it, its provider and machine, its state and the wait line. The link's description reads the meta and the line.
- A refused delegation is a row that links nowhere and says why.
- A finished turn keeps a row for each delegation in its Worked for fold, in the order they were made. Its Worked for line says "· 4 delegated threads · 1 review · Muse review · 1 needs you · 1 failed". The work still going after the reply stands under the reply, after "Still working after this reply": a Muse review and a UI thread Working, a computer-use thread with Needs you and "Waiting for your permission: npm run design:capture. Open it to answer.", and a review Starting. The answered and failed rows stay only in the fold. Each kind of work has a mark of its own.
- Under the last finished reply, the provider's own background work stands with the open delegations, in one list after the one heading: "Subagent: Read the capture code, Working" and "Workflow, Working" after the Muse review. A background command has no row, and an agent row opens nothing. Each row goes when its task leaves the thread's background work; the delegation keeps the heading. While the newest turn runs, there are none. A reply with nothing to fold shows them too ("Teammate", "Remote agent"). A thread that is disconnected, settled or archived, in error or waiting on a request shows none, the same rule as the composer's creature (`threadOrnamentAllowed`).

`thread-delegation.spec.ts` runs the real app on the Owl track with the fake Claude and Codex CLIs:

- A Claude thread delegates a review and a building job to Codex, and one research delegation is refused. The review row reads Working and the wait, then Returned with "Open it to read what it found." once Codex answers. The building row says the thread did not wait. The refused row says why, with no link.
- At 1280x800 and 820x560, in dark and light and in Citrine dark and light at 820x560, nothing in the pane is wider than the pane, and every row's words meet 4.5:1 against what they sit on.
- By keyboard, the row's link opens the delegated thread, and its "Delegated by" links back.
- Stop stops the working thread too, and its row reads Stopped.

The fixture's Claude turn writes no reply, so the spec's turns never fold. The fold, its summary and the Still working line, their contrast and their wrapping at 820x560 are checked in the unit test only, not in the running app.

## Screenshots

- `artifacts/delegated-work-in-fold/parent-dark-820x560.png`: Returned, Working and Refused rows at the minimum size.
- `artifacts/delegated-work-in-fold/parent-light-1280x800.png`: the same rows in the light theme.
- `artifacts/delegated-work-in-fold/parent-citrine-dark-820x560.png` and `parent-citrine-light-820x560.png`: Citrine.
- `artifacts/delegated-work-in-fold/parent-stopped-dark-1280x800.png`: after Stop, the building row reads Stopped.

## What has no source

- A delegation's findings are its thread's reply, which the window is never sent (ADR-0081: identities, outcome and timing only). So a returned review says Returned and opens its thread; it does not count or quote its findings.
- Delegation has no queue, so there is no Queued. A brief Sotto is still starting or sending reads Starting.
- An accepted delegation's record names no provider, so a Muse review whose thread the window no longer lists reads **Review**, with no provider and no "Open it to read what it found".
- Subagents a provider runs inside a thread, such as Claude Code's Agent tool, were already activity rows in the fold, under the word "agent action" and the Bot mark, and those rows are unchanged. While one still runs in the background after the turn's reply (October 25, 2026), it also has a row under the last reply, after "Still working after this reply", with the Bot mark, its kind (Subagent, Workflow, Teammate, Remote agent), its label and Working. Its source is the thread's background work, which is the thread's, not a turn's, so it goes under the newest reply only. It has no provider, machine, wait or line, and no link: it is not a Sotto thread. Today only Claude Code reports background work.

## Not verified

The fold and the Still working line in the running app, which the fixture cannot reach, including the background-work rows, which were checked in the unit test only (no capture, no contrast or 820x560 check in the app). Windows, the gate CI runs on. Reduced motion in the running app: the Needs you and Starting rings never turn, and the Working ring turns only without reduced motion, under the existing rule.
