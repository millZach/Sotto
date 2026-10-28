# A question asked in a folded reply stays in view

Accepted October 14, 2026 (#1019). A model would write a question for the user into a reply, keep working and end the turn with a later reply. The turn fold puts every reply but the last under "Worked for …", so the question went with them, and the user often never saw it. The guide promised that questions written as ordinary chat text remain in the conversation; the fold had quietly broken that. ADR-0043 fixed the other half of the same symptom, a Claude Code session that had no question tool at all. Every provider's question tool now reaches a request card. What remained was models not using it, and Sotto hiding what they wrote instead.

Zach chose the fix from a prototype of four finished-turn views (the tag `prototype/question-visibility`): as it ships, every reply staying on screen, questions lifted out from under one fold, and one work line with every reply after it. He picked the lifted questions, and chose that a question card's answered question folds with the work as it does today.

## Lifted questions

A finished turn keeps its one fold. Each sentence ending in a question mark in a reply the fold hides is quoted under the fold, with who asked it, the time of the reply and **Show where it asked**, which opens the fold, brings that reply into view, marks it for a moment and moves focus to it. Up to four questions are quoted from one reply, with a count of the rest. The final reply, a running turn and a turn whose start is above the history window lift nothing, because nothing of theirs is folded.

Sotto picks them by punctuation alone, in the reply's paragraphs and list items as the transcript's own Markdown reading (`remark-parse` with `remark-gfm`, which `react-markdown` already bundled) draws them. So a question wrapped over several lines is one sentence, and code, headings, tables and block quotes are skipped whatever line shape made them. A question mark inside inline code is the code's, an abbreviation such as "e.g." does not end a sentence, and a sentence of fewer than three words is passed over. `unified` and `remark-parse` are declared as devDependencies for this at the versions already installed; they add nothing to the bundle. That is a guess, and it is the one Zach chose knowing it: it will quote an aside the model answered itself and miss a question asked without a question mark. Every reply staying on screen guessed nothing, but made long turns long again. A lifted question is for reading. It is not a request: the sidebar does not say the thread needs an answer, nothing is sent, and a reply typed in the composer is an ordinary prompt. `docs/verification/codex-questions-thread-agents.md` records that Sotto does not infer structured questions from prose, and that still holds.

The iPhone and Android clients never fold replies, only the steps between them, so they need no change.

## Telling each provider to ask with its tool

The guidance Codex has had since ADR-0005 now comes from one place, `questionInstructions` in `src/main/agents/questionInstructions.ts`, with the provider's tool named. It is added to the provider's own instructions and replaces nothing.

| Provider | How it is told | Reaches |
| --- | --- | --- |
| Codex | Appended to the native developer instructions on start and resume, as before. Its text is unchanged. | Every thread |
| Claude Code | `--append-system-prompt` on every thread process (new, resumed, early start, replacement). Watcher's process gets the guidance and then Watcher's prompt. | Every thread |
| Grok Build | `_meta.rules` on `session/new` only. | Threads created from this version on |
| Devin | Nothing. Its profile is pinned and checked on readback, and it imports no rules (ADR-0073). | No thread |

Amended October 28, 2026: the guidance also says the question panel shows only the question and its choices and that the user never sees the thread's thinking, so what they must read before answering goes in the reply text before the question or in the question itself. This changes Codex's text too.

The same day, Watcher's replies written just before a question card showed in no window. Claude Code 2.1.312 asks the API by default for thinking shown as updates (`CLAUDE_CODE_THINKING_DISPLAY_UPDATES`), and under it the server may replace the prose a model writes between tool calls with a short summary in a thinking block whose signature is tagged narration. The reply never reached Sotto as text: Sotto drew the summary as a Thinking row inside the turn's fold and the card below it. Sotto now starts every Claude thread process with `CLAUDE_CODE_THINKING_DISPLAY_UPDATES=0`, so the prose comes back as text and becomes the reply above the card.
| Muse | Nothing. MSP's `session/start` has no instructions field (ADR-0079). | No thread |

Grok was checked live on Grok Build 1.0.52 (`docs/verification/2026-10-14-question-visibility.md`). Its built-in documentation calls `rules` "extra rules appended to the system prompt", where `systemPromptOverride` is a replacement. A rule given at creation was followed in that process and, after the process was killed, in a new process that loaded the session with no rules. Rules sent with `session/load` were ignored without an error. So the rule rides creation only, an existing Grok thread never receives it, and a change to its wording reaches new threads only. Watcher on Grok keeps its override exactly as ADR-0073 pins it and gets no rules, because the override replaces the system text the rules would be appended to. ADR-0073's "creation-only and cannot satisfy resume" is right that rules cannot be given on resume; they are not lost on it.

Guidance is not enforcement. A model can still ask in prose, which is why the lifted questions exist; the two together cover every provider.
