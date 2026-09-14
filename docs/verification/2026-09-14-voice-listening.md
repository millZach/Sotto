# Voice listening diagnosis

User report: intermittent “Hey Sotto” activation and no reply while the home screen says “Sotto is listening.” Baseline `046d793`; Windows desktop target from the supplied screenshot. Preserve existing user screenshots and all live drafts.

## Acceptance checklist

- [x] Inspect the running development app and recent voice turn records without exposing credentials.
- [x] Reproduce hidden composition: live state was composing with a 74-character draft; three successfully transcribed questions were appended without invoking reasoning.
- [x] Red renderer regression: `npx vitest run tests/unit/renderer/agentView.test.tsx -t 'reveals active prompt'` fails because the home screen hides draft mode.
- [x] Red routing regression: `npx vitest run tests/unit/main/agentControlRecovery.test.ts -t 'returns from hidden prompt'` fails for both button and spoken exit; the spoken exit itself is appended to the draft.
- [x] Expose prompt ownership and a reversible return to coordinator conversation; preserve saved text across restart and review.
- [x] Verify quiet command capture through the shipped worklet and actual local detector replay; distinguish synthetic evidence from physical wake accuracy.
- [x] Focused regression suites, typecheck, lint, build, and rendered desktop journey.
- [x] Zach's physical wake-and-reply check in the updated app: “It wakes and replies.”

## Ranked explanations

1. Hidden composition consumes questions as draft text. Prediction: explicitly pausing composition while retaining its saved draft makes the same question reach the coordinator and produce feedback.
2. Activated capture uses a higher volume gate than wake capture. Prediction: identical quiet PCM emits a segment before activation but disappears afterward.
3. Microphone/accent/room effects outside replay fixtures affect real wake detection. Synthetic replay cannot establish or disprove physical wake accuracy.

## Scoped visual checks

This is Sotto's existing desktop voice home: the visible state must identify whether speech is a prompt or a conversation. Considered approaches: show the draft below the orb; automatically open its side sheet; change the caption with review and exit controls. Choose the caption and controls to retain the existing orb hierarchy without forcing navigation.

- Keep the screenshot's orb, typography, theme roles, and existing motion/reduced-motion behavior; no new decorative motion.
- While listening and composing, show the destination in the heading, one operating instruction, Review draft and Talk to Sotto; suppress the misleading attention suggestion and stale notice. Wake/muted states retain their activation instructions, and speech/error feedback remains visible.
- Review draft opens the existing editor with the original text. Talk to Sotto saves the draft and exits dictation without submitting anything. Exact spoken “Talk to Sotto” provides the same exit.
- Inspect normal desktop and minimum 820×560, light and dark, keyboard focus and overflow. The new caption has four primary text elements; operating/error feedback uses the existing essential-state exception.

Physical microphone verification was deferred in the previous task; this diagnosis must not claim that fixture replay verifies Zach's live pronunciation or room.

After the fixes were running, Zach explicitly tested the offered “Hey Sotto” → “What needs my attention?” journey and replied **“It wakes and replies.”** That verifies this physical attempt; it is separate from synthetic accuracy measurements and does not establish a wake success rate across accents or noise conditions.

## Result and independent review

The home screen now distinguishes conversation from prompt dictation. Talk to Sotto (button or exact spoken phrase while composing) retains the original saved draft, clears automatic answer/draft capture and returns to coordinator conversation. That routing choice survives restart. Selecting a saved draft displays its text and images read-only until Resume draft; resuming does not grant management authority.

Independent review found and root/subagent regressions resolved the paused-editor overwrite, pending-question interception, missing wake instructions, repeated-resume loss of skill references, next-item question routing, and unbound recovery protection. The final reviewer reported no outstanding material findings.

Live verification then exposed a second response-routing defect: the configured coordinator answered the advertised “What needs my attention?” with a request to choose a thread to draft the question in. The exact non-composing status query now reads the bounded saved attention queue directly, without inference, dispatch, or permission answers. Two red tests covered empty and permission queues; repeat queries each publish feedback and leave all requests unchanged. General conversation still uses the configured coordinator; this does not turn the Agents home into the separate personal Chats feature.

Root exercised the final public command in the running development app and observed “Nothing is queued for your attention.” with no error. This was a command-boundary check, not microphone speech. Root used the new pause command to recover the live app's hidden 74-character draft and checked its text, attachment list and request identity against their pre-action digest. The app remains running in Agents mode; the existing draft is saved, not submitted. No credentials or microphone/device settings were changed.

## Verification evidence

- Quiet command replay and its limits: [capture report](wake-listening-capture-2026-09-14.md). Wake positives 70/70, negatives 280/280, activated commands 38/42 (all 36 at gains 0.1–1 pass; four extreme gain-0.05 cases remain below the existing capture floor).
- Final routing/recovery suite: 65 tests passed. Paused and active composer suites: 31 passed. Capture/session/wake suites: 35 passed. Node/web typecheck, ESLint and production build passed.
- `npx playwright test tests/e2e/voice-home-recovery.spec.ts --workers=1`: passed on the final build. Real renderer/controller journey with fixture microphone/transcription/provider effects covers wake → draft → review → keyboard exit → status reply → saved editor → explicit resume → edit → spoken exit. No project messages were sent.
- Root inspected all four normal/minimum light/dark drafting captures and the minimum paused editor under `artifacts/voice-home-recovery/`. The orb remains dominant, four caption text elements are readable, controls fit at 820×560, the saved text and Resume draft action remain visible, and keyboard activation succeeds. Existing motion is unchanged; captures use reduced motion. Original live screenshot and the final running app were also inspected; private live captures remain in the ignored debug directory.
- The first new Electron test sent its fixture wake during the existing 500 ms speaker-echo guard immediately after disabling replies. The test now waits for that known guard. A subsequent Electron launch failed before renderer startup; unchanged retry and the final rerun passed. Neither was used to justify detector tuning.
- Final full suite (`npx vitest run --maxWorkers=2`) passed **3,354 tests, 22 skipped, zero failures**, across 250 test files. The earlier complete run passed 3,349 tests before the last review and status-query regressions were added. Counts are retained in [voice-listening-suite-2026-09-14.json](voice-listening-suite-2026-09-14.json).

No temporary debug logging remains in production code. Task-local repro scripts and private runtime checks stay clearly isolated in `.claude/tmp/`. The preventive tests cover the formerly missing seams: actual microphone PCM across wake activation, saved draft recovery in the visible editor, and the home screen's advertised query through the real controller.

Delivery: committed locally on `main`; the development app is running the fixes. No push, release packaging or publication was performed. The two pre-existing user screenshots remain untouched and uncommitted.
