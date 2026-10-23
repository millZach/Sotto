# Settings is nine pages in four runs, with Find a setting

## Status

Accepted October 22, 2026. Zach picked structure B, "Fewer, longer pages", from `docs/prototypes/settings-structure-prototype.html`, the mock-up made from his note through Watcher: "The applications settings pane is cluttered and has a bunch of stuff that should be in separate settings pages." He also asked for a way to search Settings, on stable, and for every **Open Settings** button to open the page it is about.

Amends ADR-0041, whose worktree cleanup rules stayed under Settings → Application; they are now under Settings → Git & worktrees. Amends ADR-0027 decision 7 only in where its section sits: Settings → Git is now Settings → Git & worktrees, with the same groups by moment and one more before them.

## Context

Settings had twelve pages, fourteen with Owl features. Application, the page with the id `settings-privacy`, held 24 rows on six topics: startup, how threads behave, worktrees, history, updates and reset. Reduced motion, a look, sat there too. Cleanup held the three Generated switches, which are side calls to the thread's own provider (ADR-0026) rather than OpenRouter cleanup, so with dictation off (ADR-0107) Cleanup survived only for them. Show floating widget when idle, a dictation setting, was on Application, and so was Let agents babysit pull requests, beside Git's pull request group. Transcription and Output were pages of two and four rows. The sidebar's two dividers were placed by position, after the third and seventh rows, so they fell in the wrong place once Watcher or Performance showed. There was no way to find a setting but to read every page, and every **Open Settings** press landed on Dictation.

Three structures were drawn, each placing all 74 settings once: A, four headed groups of fifteen short pages; B, fewer, longer pages of titled groups; C, four areas with tabs across the top.

## Decision

1. **Nine pages in four runs**, a divider between runs: **Dictation** and **Cleanup**; **Threads**, **Git & worktrees** and, in Owl, **Watcher**; **Providers**, **Hosts & phones** and **Cloud iPhone**; **Appearance**, **Application** and, in Owl, **Performance**. `src/renderer/src/features/settings/settingsPages.ts` holds the list and its runs; the divider follows a page's run, not its position.
2. **Each page is a run of titled groups**, the cards of ADR-0110.
   - Dictation: Microphone, Shortcuts, While you dictate (with the floating widget), Speech model (the old Transcription page) and After you dictate (the old Output page).
   - Cleanup: AI formatting, the OpenRouter key and the personal dictionary. It leaves the sidebar while dictation is off.
   - Threads (the old Agents page): New threads, Projects, Working copy, In a thread (Replies in threads, Generated thread titles, Resume threads after a restart), Links and Sotto's browser, and What agents can do without asking.
   - Git & worktrees: Removing worktrees first, then the groups by moment, with Generated commit messages under When a thread commits, and Generated pull request text and Let agents babysit pull requests under When a pull request is made or merged.
   - Hosts & phones: the Hosts page, then Phones as a group.
   - Appearance gains Reduced motion.
   - Application keeps only the app itself: When your computer starts, History, Notifications (in Owl on a Mac, ADR-0117), Updates and Start over.
3. **Every old section id still opens somewhere real.** A page keeps its id, and a page that became a group gives its id to the group: `settings-transcription`, `settings-output`, `settings-phones` and `settings-updates`, with new ones for `settings-worktrees`, `settings-browser` and `settings-history`. Opening a group opens its page and scrolls to it. `settingsReachable.test.tsx` opens every id Settings has answered to.
4. **Find a setting**, at the top of Settings' sidebar, lists every setting whose name, description words or other names hold what is typed, with the page each is on, in place of the pages. Pressing one, or Enter for the first, opens its page with focus on the setting. It is on stable. It reaches only what the page shows now, so no Owl setting on stable and no dictation setting while dictation is off. Its index is a list in `settingsPages.ts`; the same test holds it to the pages both ways: every entry names a control on its page, and every control on a page is reached by an entry.
5. **Open Settings opens the page it is about.** `navigate('settings', section)` carries a section, and Settings opens there:
   - a cloud iPhone problem, and Tools › iPhone without a key: Cloud iPhone;
   - Watcher with no provider, and the Threads page's error: Providers;
   - the Dictate room's speech model problems: Speech model;
   - no microphone: Dictation;
   - the journal with history off: History.
6. **Words follow the pages.** Pointers in Sotto's messages, the iPhone and Android clients, README, the guide and `CONTEXT.md` say Settings › Hosts & phones, Threads, Git & worktrees and Dictation where they said Hosts or Phones, Agents, Git and Transcription. ADRs and verification notes keep the words of their day.

## Consequences

- Fewer places to look, but Dictation and Git & worktrees are long pages; their groups are what make them readable.
- The rail scrolls at the 820 × 560 minimum, as it did with twelve pages, because Find a setting takes a row. The open page stays in view.
- The design capture baselines for Settings change and are regenerated on the machines that hold them.
- The iPhone and Android clients say Hosts & phones from their next release; until then they name Settings › Hosts or Phones, which Find a setting still finds.
- A new setting goes on a page's group and in `settingsIndex`; the reachability test fails until it does.
