# Verdict: pull request babysitting (#822)

The question: how should a thread babysitting its pull request look? Specifically, where Start and Stop sit on the Pull request surface, how the thread looks in its sidebar row and its pane, how a wake-up reads in the thread, and what the Settings switch is called and where it sits.

Zach picked **variant C, "A state of its own"**, on October 8, 2026, from the review page on his phone.

- **The Pull request surface.** A line docked above Merge with Stop. When nothing is babysitting the pull request, Babysit pull request is in the ··· menu.
- **The sidebar row.** Its state reads "Babysitting #74" where it would say Done.
- **The pane.** A fourth creature pose sits at rest above the composer, below every other pose.
- **A wake-up.** A message on the user's side, labelled Sotto, showing the whole text.
- **The Settings switch.** "Let agents babysit pull requests" in Settings → Application.

The same day he confirmed:

- the word babysit
- the switch turns off only the agent's tool
- a wake-up carries links, never what anyone wrote

Variants A ("A quiet line") and B ("On the badge") stay in this file for reference. The decision is recorded in ADR-0061 on `feat/pull-request-wake`, and #825 builds it.
