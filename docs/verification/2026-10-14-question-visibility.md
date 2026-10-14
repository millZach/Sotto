# A question asked in a folded reply stays in view

October 14, 2026, for #1019 and ADR-0080. Windows 11, from `fix/question-visibility`.

## Lifted questions in the running transcript

`tests/e2e/thread-activity.spec.ts` › "a question a folded reply asked stays in view under the fold and leads back to that reply (#1019)" mounts the real Threads page and transcript in Electron with the activity fixture's new `asked` scenario: the settled WAV turn, whose middle reply asks in bold whether to patch the length on a timer and then carries on. At 1600x1000, 1280x800 and 820x560, in dark and light, the turn shows the user's message, the closed **Worked for 2m 04s** line, the quoted question under it with "Codex asked while working" and the reply's time, and then the final reply. Only two messages are drawn, so the reply that asked is still folded. Nothing scrolls sideways. The speaker line, the question and **Show where it asked** each measured at least 4.5:1 on the block's own background in both themes.

The keyboard path was driven at 820x560: focus on **Show where it asked**, Enter. The fold opened, the asking reply came into view with the focus on it and its mark showing, and the mark cleared on its own. With app reduced motion on, the mark has no visible fade. Escape inside the opened fold closed it and put the focus on its line, and the quoted question stayed.

The captures were opened and checked: [1600 dark](../../artifacts/question-visibility/asked-1600-dark.png), [1280 light](../../artifacts/question-visibility/asked-1280-light.png), [820 dark](../../artifacts/question-visibility/asked-820-dark.png), [820 light](../../artifacts/question-visibility/asked-820-light.png) and [after Show where it asked](../../artifacts/question-visibility/asked-where-820-light.png). The fixture page leaves the sidebar unstyled, as in the spec's other captures.

`tests/unit/renderer/liftedQuestions.test.ts` covers what counts as a question: bold questions mid-paragraph, list items, links read as their words, inline code read as its text, code blocks, headings, tables and quotes skipped, abbreviations, short asides, duplicates and very long sentences. `tests/unit/renderer/threadTranscript.test.tsx` covers the transcript: only folded replies lift, the final reply and a running turn lift nothing, Show where it asked hands the transcript the asking reply, and a reply with more than four questions says how many more it asked.

## Telling the providers

- **Claude Code.** `tests/integration/claudeAdapterSafety.test.ts` checks that every ordinary thread process gets exactly one `--append-system-prompt`, holding the AskUserQuestion guidance. `tests/integration/watcherOwnTools.test.ts` checks that Watcher's process gets the guidance followed by Watcher's prompt. The fake CLI now tells Watcher apart by its prompt, not by the flag alone.
- **Codex.** The guidance text is unchanged and now comes from the shared module. `tests/integration/codexQuestionPopup.test.ts` passes as before.
- **Grok Build.** `tests/integration/grokAdapterRuntimeModes.test.ts` checks that `session/new` carries `rules` with the `ask_user_question` guidance in every permission mode, and that every `session/load` after a restart carries exactly the permission settings and no rules. Watcher's Grok launch is unchanged and still checked exactly.

Grok was also checked live on Grok Build 1.0.52 (0920c8169e27), launched as the adapter launches it, in a scratch folder:

1. `session/new` with `_meta.rules` as a plain string, holding two test word mappings. Prompting the first word gave the mapped reply.
2. The process was killed. A new process loaded the session with `_meta` holding only the permission settings, as Sotto resumes. Prompting the second word, which appeared only in the rule and never in the conversation, gave its mapped reply. The rule survives a reload.
3. A session created without rules answered the first word as an ordinary prompt.
4. Loading that session with `rules` on `session/load` was accepted without an error and had no effect. Rules cannot be added after creation.

Grok's built-in documentation describes `rules` as appended to the system prompt and `systemPromptOverride` as replacing it. Both test sessions were deleted with `grok sessions delete`.

## Not verified

No live Claude Code, Codex or Grok model was shown to pick its question tool because of the guidance. As ADR-0005 recorded for Codex, the tests prove what each session is told, not what a model chooses. The lifted questions are the part that does not depend on that choice.
