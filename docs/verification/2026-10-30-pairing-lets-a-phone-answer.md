# Pairing lets a phone answer

The **Can answer** switch is gone (ADR-0033, October 30 amendment). Pairing a phone with a code writes its
`remote-answer` record, every start writes it again for a paired phone without a lasting one, and Remove is the
only way to take it away.

## The Phones page, before and after

Captured on forge under Xvfb by `tests/e2e/phones.spec.ts`, whose `paired` capture shows a phone just paired with
the page's code. Before is `main` at f89066818; after is this branch.

- `artifacts/pairing-can-answer/before-phones-paired-1280-dark.png`: the row has the **Can answer** switch, off,
  and reads "Reads and replies. Can’t answer questions or permissions." The pairing note says the phone answers
  only after you turn on Can answer.
- `artifacts/pairing-can-answer/after-phones-paired-1280-dark.png`: the row has only **Remove** and reads "Reads
  and replies. Can answer questions and permissions." The pairing note says a paired phone answers, and that
  removing it takes that away.
- `artifacts/pairing-can-answer/before-phones-paired-820-light.png` and
  `artifacts/pairing-can-answer/after-phones-paired-820-light.png`: the same at the window's minimum, light.
  Nothing overflows; the spec checks the page and the settings form for horizontal overflow at every size.

The spec also checks that the phone's hello says it may answer as soon as it pairs, and that Remove refuses its
next connection.

## Not proven here

- A host's Phones dialog: `tests/e2e/host-phones.spec.ts` stops at "forge is connected" on forge on `main` as
  well, so its row is proven by `tests/unit/renderer/hostPhonesDialog.test.tsx` and the host's side by
  `tests/integration/hostPhoneAccess.test.ts`.
- The iPhone: forge has no Swift toolchain. The Native iOS client job in CI builds it and runs its journeys.
- Android: no CI job builds it (ADR-0059). Its changes are copy and one removed row.
