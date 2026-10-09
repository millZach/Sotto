# One cleanup model verification

October 9, 2026, on `feat/one-cleanup-model` from `main` at cc732e39. The decision is
[ADR-0065](../adr/0065-one-model-does-ai-cleanup.md); the measurements are
[the 2026-10-09 benchmark](../perf/2026-10-09-cleanup-haiku-5-5.md). The owner picked the look from a throwaway
before/after prototype of Settings → Cleanup, captured as the tag `prototype/single-cleanup-model`, which stays off
`main`.

## Settings → Cleanup

The Formatting quality picker is gone; the AI formatting switch, the personal dictionary and the generated-text
switches are as they were. `npm run design:capture` regenerated the baselines, and only
`artifacts/design/app-review/baseline/settings-cleanup.png` is committed: the row's removal makes it 103 pixels
shorter. Seven other captures differed from their baselines by 9 to 64 pixels, and the onboarding agents step by
4,330, none of them on a surface this change touches; those were left as they were. `node
scripts/verify-design-captures.mjs` verifies all 152 tuples against the committed images.

`tests/e2e/settings-index.spec.ts` passed. It opens every Settings category, Cleanup among them, at 1280x800,
1600x1000 and 820x560 in dark and light, and fails on page overflow, form overflow or a clipped control.

## Cleanup against OpenRouter

The real `TranscriptPolishService`, loaded from this branch and given the owner's key and a four-word dictionary,
cleaned one transcript twice through OpenRouter:

- As shipped: one request, `anthropic/claude-haiku-5.5` with `reasoning: { effort: "low" }`, in 1.85 s. "in sato no
  wait in the settings page" came back as "in the settings page", and "wisper flow" as "Wispr Flow". "zack" stayed
  "Zack" although the dictionary held "Zache": the dictionary is a hint the model weighs, not a rule.
- With the first request answered 503 on purpose: a second request to `inception/mercury-2` with reasoning off,
  in 0.49 s in all, applied, attempts `["http-503", "ok"]`. Mercury 2 kept "in Sato".

The script ran from outside the repository and logged neither the key nor anything to Sotto's files.
