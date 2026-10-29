# Tips come from what they point at

## Status

Accepted October 28, 2026. The owner asked for tips like the one Claude Code shows under its spinner: about Sotto, and about the commands, skills and tools of the thread's provider, Claude Code and Codex first, Sotto's own tips for every other provider (#1767). They show while a thread works and on Watcher's page while Watcher works, are on by default with a switch in Settings, and a tip the user hid or used does not come back. From `docs/prototypes/thread-tips-prototype.html` (tag `prototype/thread-tips`) the owner picked B, a row under the working words, with a lightbulb in place of the word "Tip"; one tip per turn; and a Show hidden tips again button beside the switch. An Owl feature, `thread-tips` (ADR-0072). **Number provisional until merge** (docs/agents/domain.md).

## Context

A tip that names a shortcut the user has moved, a setting that was renamed or a provider command that no longer exists is worse than none. Sotto ships often, the providers ship more often, and a list of tips written once goes stale without anyone noticing. Sotto also contacts no host for anything the user did not ask for, so it cannot fetch fresh tips at run time.

## Decision

1. **Where and how a tip shows.** One row under the working words of a running turn (ADR-0134's working line), and under Watcher's, while the provider is connected: a hairline hook to the words, a lightbulb, the tip in the muted ink a size down, and after its words Try it, where the tip has something to put in the prompt, and Hide. Once the turn's steps are open the tip sits between the words and the steps. It is a `note` named "Tip", never a live region, and moves nothing when it comes or goes. Under reduced motion it appears without the fade.
2. **One tip per turn.** A turn keeps the tip it started with. The next turn shows the next tip in the rotation, which is kept on this computer so it carries on after a restart.
3. **Hide and Try it set a tip aside for good.** Its id goes on a list kept in this window's storage, as a dismissed notice is (`sotto.tips.setAside`, ids only). Settings › Threads › Show hidden tips again empties the list. Show tips while threads work (`threadTips`, on by default) turns every tip off. Try it on a skill puts the skill in the prompt as the skills list would; Try it on a question puts the question there; then focus goes to the prompt. After Hide, focus goes back to the working line, or to the transcript.
4. **Every tip is built from something Sotto can check.** None is a sentence that only a person keeps true:
   - **Sotto's tips name what they point at.** A shortcut tip names a thread shortcut id and shows the keys the user has now, and goes away when the user removes the shortcut. A setting tip names a setting key and shows only while that setting makes it true. A tip about an Owl feature names the feature and shows only where it is on. The ids are typed, and `threadTips.test.tsx` fails when a setting a tip names is gone.
   - **Skill tips come from the thread's own catalog.** When the user has already loaded a Claude or Codex thread's skills, a tip names one of them, the project's and the user's own first, with the provider's own description. Before that, a tip says which key opens the skills list. A tip never asks the provider for its catalog.
   - **Documentation tips record their source.** A tip from Claude Code's or Codex's documentation has an entry in `src/renderer/src/agents/tipSources.json`: the page, the sentence the tip rests on, and the day it was checked. A weekly workflow (`.github/workflows/tip-sources.yml`, `scripts/check-tip-sources.mjs`) reads each page on GitHub's runners and opens an issue, or adds to the open one, when a page has lost its sentence or is gone. A page it cannot reach is only warned about. GitHub Actions may not open pull requests in this repository, so the issue asks a person or an agent to rewrite or remove the tip.
5. **Provider tips are Claude Code's and Codex's.** Every other provider's thread gets Sotto's tips only. Watcher's line gets Sotto's and Watcher's own tips, never a provider's.

## Consequences

- Sotto contacts no new host. The tips ship in the app, and the documentation pages are read only by the weekly job, on GitHub. The README's hosts are unchanged.
- A documentation tip can be wrong for up to a week after a provider changes its page, and until someone acts on the issue. Fewer documentation tips means less of that; most tips come from the catalog, the settings and the shortcuts, which cannot drift.
- New tips go in `tips.tsx`, each naming its target. A documentation tip also needs its source entry; the unit test fails on a tip without a source or a source without a tip.
- The provider changelogs are not watched. A new provider command reaches the tips through the thread's catalog, not through a list.
