# Settings → Git, grouped by moment (#271), 2026-09-23

Proof that the Git settings now live in one Settings section, grouped under when each one acts, as the owner picked (variant B of `docs/prototypes/git-interface-surfaces/settings.html`), and that the section fits, reads and saves in the built app. Screenshots are in `artifacts/git-settings/`.

## What changed on screen

Settings gains **Git** at the end of the section list. Its four groups, in order:

- **When a thread commits**: Commit and pull request style, the Custom instructions field while Custom is chosen, and an example of a commit subject and pull request title.
- **When a pull request is made or merged**: Follow pull request templates, Default merge method, Auto-settle merged threads.
- **When you read Changes**: Diff layout, Hide whitespace changes, Default diff file state, Proactive panels.
- **In the background**: Git fetch interval, Automatically pull.

Each description is one sentence about what Sotto will do with the value shown, and it changes when the value does. Application keeps the worktree rules; Cleanup keeps the Generated switches, whose descriptions now point to the style under Git. No setting, stored key or allow-list entry changed. The diffs still start collapsed with whitespace hidden.

The prototype's example rewrote the subject from custom instructions with a few pattern rules. That would be Sotto guessing at a model's answer, so the built example keeps the plain subject under Custom and says the thread's own model applies the instructions when it drafts. It still follows typing: with nothing written it says drafts follow Repository conventions, and once text is typed it says it shows the subject before your instructions.

## Unit

```powershell
npx vitest run tests/unit/renderer/settingsView.test.tsx tests/unit/renderer/themeTokens.test.ts tests/unit/release/designCaptureMatrix.test.ts
```

`settingsView.test.tsx` checks the ten sections and their keyboard order, the four groups and the controls in each, that Application and Cleanup keep none of the moved rows, every save, each description before and after its value changes, the example for all three styles, the note shown when both Generated switches are off, and that custom instructions typed just before the style changes are still saved once.

## In the built app

```powershell
npm run build && npx playwright test tests/e2e/git-settings.spec.ts tests/e2e/settings-index.spec.ts
```

`git-settings.spec.ts`:

1. At 1600×1000, 1280×800 and 820×560, dark and light, top and bottom of the section: no page or form overflow and no control cut off. Every text in the example block, and each group heading, measures at least 4.5:1 against its surface (`git-1600-dark.png`, `git-1600-dark-bottom.png`, `git-1280-light.png`, `git-820-dark.png`, `git-820-dark-bottom.png`).
2. From the panel, Tab goes through the style, templates, merge method, auto-settle, diff layout, whitespace, file state, Proactive panels, fetch interval and Automatically pull, top to bottom. Space on Automatically pull saves it and its description changes to the fast-forward sentence. Arrow keys move Diff layout, and that saves too.
3. Conventional Commits shows `feat(threads): name a thread from its first exchange` (`git-1280-dark-conventional.png`). With Custom instructions, the field is one Tab after the style. Typed text saves when typing pauses and survives a reload, and the example's note changes as you type (`git-820-light-custom.png`, `git-1280-dark-custom.png`).

`settings-index.spec.ts` now includes Git in its sweep of every section at every size and in both themes.
