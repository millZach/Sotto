# The Duo design climb

Started November 8, 2026. Zach asked for the desktop's design climb (PR #2305) on the iPhone app, on the iPhone Duo's layout only: how the app looks and reads on the Duo, folded and unfolded, not the layout every other iPhone has. It follows the desktop climb's method.

## What the Duo is here

The iPhone Duo folds (ADR-0151). Folded, its cover screen is compact width, with the tabs, or an open thread's controls, in the strip down the right edge. Unfolded, the inner screen is regular width both ways: held sideways (951×669 points) the rail stands in the clock's strip with the thread sidebar beside the page; held upright the rail is a column down the right edge and the sidebar comes over the page. No other iPhone takes this layout, so every change here applies only on the Duo.

## The method

1. **Captures from the real app.** `apps/ios/Scripts/duo-captures.sh` runs `DuoCaptureTests` on the iPhone Duo simulator on the `xcode-27` runner, folded and unfolded sideways, and keeps a picture of each surface in dark and light and a short video of each movement. The simulator can't turn the unfolded Duo upright (`--ui-orientation` and `XCUIDevice` both leave it sideways), so the judges score folded and sideways from the real app; upright changes are checked in their prototypes and on Zach's Duo. A push to a `duo-captures/<name>` branch runs it (`.github/workflows/ios-duo-captures.yml`), so a round's captures never restart the pull request's CI. `duo-captures/climb-before` is `main` at `235dd51b4` with only the capture lane added: the before of every image.
2. **Judges.** Each round, three fresh judges (GPT-6.1 Sol, Claude Opus 5.5 and Claude Fable 5.2, Zach's pick; Fable 5.2 took GPT-6 Astra's seat from round 2 on, November 9, 2026) score the Duo layout out of 10 against the comparison set, from that round's captures, with no tools beyond reading the files they are given and no memory of earlier rounds. The comparison set is T3 Code, Claude and ChatGPT with Codex from Zach's own screenshots on his Duo, folded, sideways and upright, with T3's App Store images for its thread and approval views (Zach's T3 was offline), and Cursor's for the folded set. Those screenshots stay out of the repository: they show his own thread titles and tailnet addresses. Their brief carries the decisions below as fixed. The climb was to end when every judge scored Sotto 9.5 or higher; after round 7, with the scores holding between 8.5 and 9.5 as each round found new small things, Zach chose to end it with round 8 and open the pull request whatever its scores.
3. **Zach decides.** A judge's finding becomes a change only through Zach. For each surface the judges want changed, a prototype with variants A, B and C opens on the Duo from a tailnet link, and a question card asks which to build, with a recommendation. Only the pick is built. A finding that would reverse an ADR gets its own prototype and question first, and the ADR is amended only on his answer.
4. **Batched rounds.** A capture run takes most of an hour, so each round builds every pick Zach has made, then captures once and judges once.
5. **One pull request** carries the capture lane, every change, the verification note with a before and after image of each surface and a short before and after video of each change, and the ADR amendments. The last check is Zach's on a TestFlight build on his Duo.

## Decisions the judges must keep

These are Zach's (or Drake's, accepted) and stand unless Zach changes them. A judge may say one costs the score, but may not propose a change that undoes it without saying so plainly, so it can go to Zach as a question.

- **Glow look (ADR-0051).** Sotto's own character: the theme's room, Figtree, dark by default, colour from the theme. Cards are flat, one fill a step off the room; a Needs you card glows, and the Threads tab's working and answered cards keep their glow. The reply box is Messages-shaped: a slim solid box with + as its own circle beside it, Send inside its end, Stop beside it while a turn runs, floating with the conversation running under it and no fade (October 31). The glow has a slider.
- **The small reply box (ADR-0184).** In a thread with content and in Watcher, the box is one row until the user writes.
- **The reply box's settings line (ADR-0166).** Model, effort, speed and permissions as chips on the box's second line.
- **The Duo's layout (ADR-0151 and its amendments).** Threads unfolded is columns of cards, answered in place, when no thread is open; every other Threads page is the thread list. One page at a time; the sidebar is the thread list beside a page. Tabs are icons alone in one pill of 50-point tiles, low on the right where the thumb rests, with the sidebar's button and New thread at the top of the rail. A thread has no top bar and no big title on the Duo: its state, Agents, Watch and ••• stand in one pill on the rail, and its name, branch, changes and pull request are at the top of •••. Folded, Back stands where New thread does. Sideways, New thread moves into the sidebar's heading while a thread is open. A drag moves the sidebar. Edge to edge: the page's ground runs under the rail and the strip. Pages keep a 24-point margin unfolded; a thread and Watcher keep the 680-point reading width.
- **Threads list rows (ADR-0151, October 30).** A Needs you row is a row like the others; nothing is answered on the list. Unfolding onto the list opens its top row.
- **Movement (ADR-0151, October 31).** Pushes and pops are iOS's own; tab and sidebar changes fade; the fold reshapes on a spring; Reduce Motion fades.
- **Watcher's room is its conversation (ADR-0152, ADR-0073).** No tabs or bar over it.
- **The pull request sheet (ADR-0102)** and **Agents (ADR-0103)** as sheets from the thread; read only.
- **Pictures as tiles (ADR-0170).** **Steps fold under the working words (ADR-0051 October amendments, ADR-0134).**
- **Themes (ADR-0011, ADR-0024, ADR-0150).** Sotto's palettes in light and dark, and Glass in Owl.
- **Privacy and permissions (AGENTS.md).** Nothing answers a request for the user; a request is answered on its sheet.

## Rounds

Each round's captures, scores and Zach's picks are added here as the climb goes.

### Round 0 (November 8, 2026)

Captures: `duo-captures/climb-before`. Scores: Claude Opus 5.5 7.5, GPT-6.1 Sol 8.0, GPT-6 Astra 8.0. No judge asked for a reversal. Muse Wonder Full was Zach's first pick for the third seat; a judge named in the Code review role came up on Sol, and Zach chose Astra instead.

Zach's picks, from `docs/prototypes/ios-duo-climb/index.html`:

| Surface | Pick |
|---|---|
| Question sheet | A, fits its choices |
| Pull request sheet | A, one-row dock |
| ••• menu | B, own card with ranked lines |
| Sidebar rows | C, two-line names with the time below |
| Settings | C, labels beside controls, and a labelled sample |
| Computers | C, Add a computer as the list's last row |
| Glow on controls | C, only New thread glows at rest |
| Agents sheet | B, sections by state |

Three findings were the capture, not the app: no Stop (the fixture had no stop capability), no chips and a grey Send (it had no settings or send capability), and a "blank" conversation above a sideways reply (the fixture thread is short; the picture shows it whole). Agents' third section is headed Finished rather than the prototype's Answered, and its rows keep their status words, because real rows also say Finished, Stopped and Just finished.

### Round 1 (November 9, 2026)

Captures: `duo-captures/round-1` (run 42541871862, after a first run showed the ••• card off-screen and the question sheet too tall). Scores: GPT-6.1 Sol 8.5, GPT-6 Astra 8.5, Claude Opus 5.5 8.5. No judge asked for a reversal.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-2.html`:

| Surface | Pick |
|---|---|
| Code | Wrap in every posture (his own words), with the open step's whole command under it |
| Threads overview, unfolded | B, trimmed cards and a one-row top |
| Rows' second line | B, the mark stands for the provider and a waiting row says Question or Permission |
| Finished light | A, a check in the light |
| Pull request sheet | C, a fade above the dock, a tighter top and one-line statuses |

Three findings were the capture: Watcher showed no way to the waiting question because every capture emptied Watcher's waiting cards (`--ui-watcher-nothing-waits`, now left off Watcher's own pictures); the pull request and Agents pictures showed Queue for Stop because they launched without `--ui-can-stop`; and the amber stroke on Watcher's reply box is the top-effort trace (ADR-0019) held still mid-lap. The folded sheets' hairline over their buttons stopped at the strip; it now meets the sheet's edge. Held for a later round, each raised by one judge: the folded Agents sheet's summary, Computers sideways, the rail's state pill, the New thread sheet's corners and long folded table cards.

### Round 2 (November 9, 2026)

Captures: `duo-captures/round-2` (run 42675473987; the folded reply box with its keyboard was lost in collection and not retaken, since round 2 changed nothing there). Scores: GPT-6.1 Sol 8.5, Claude Opus 5.5 9.0, Claude Fable 5.2 8.0. GPT-6 Astra also scored 8.5 before Zach gave its seat to Fable 5.2; that score is kept with the round's notes but not counted toward the bar. No judge asked for a reversal.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-3.html`:

| Surface | Pick |
|---|---|
| Threads overview | B, Recent rows without the provider's name and with the time on the second line; Review on its own row; folded, a one-line note |
| Watcher's question card | B, "Answer it on" the computer; the line over the card only when this iPhone can answer |
| Watch on the rail | B, a smaller owl with a + that turns to a check |
| State on the rail | A, Finished, and the working time folded too |
| Beside a sheet | B, the reply box steps away |
| Agents sheet | B, no summary of counts, the mark beside the name, where it runs on one line |
| Pull request sheet's top | B, state and number in the top row, details whole |
| Computers, sideways | B, two to a row, state under the name |
| New thread sheet | B, no step words or footer |
| A waiting permission's row | Permission, as built |

Fixed without a pick, as part of the code pick: a long path broke inside a name, so a break now goes after a space or a slash first. Held, each raised by one judge: text under the reply box with the keyboard up (Fable), faint choice circles in dark (Astra), the amber glow in light (Opus), the Agents badge counting every agent in amber (Opus).

### Round 3 (November 9, 2026)

Captures: `duo-captures/round-3` (run 42692585379). Scores: GPT-6.1 Sol 8.5, Claude Opus 5.5 8.5, Claude Fable 5.2 8.5. No judge asked for a reversal.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-4.html`:

| Surface | Pick |
|---|---|
| Below the reply box | As it is: the conversation keeps running on below the box |
| Overview cards | B, the mark stands for the provider and one short time, seconds only on the thread's rail |
| The glow in light | B, a third of the reach at the same strength |
| Agents sheet | B, Open to answer by the name, three lines of brief, the finished check, a badge of what needs you |
| State on the rail | B, minutes only |
| Sheets sideways | A, over the page from the sidebar's edge to the rail, as Sotto's own sheet (asked again once iOS's sheet proved unable to move) |
| Folded sheet's right side | A, wide below the clock |
| The ••• card | A, a solid card, the reply box away, a branch broken after its slash |
| Computers, sideways | A, Try again on the state line; the counts come back once it connects (asked again: the prototype said they moved to the computer's page, which shows none) |
| Watcher's question card | A, starts at the question when Watcher's words name the thread |
| Settle in ••• | Keep "Settle", the glossary's word everywhere |
| Small fixes | All four: the provider's mark on a turn, grey Send in light, the sidebar's fade, the lighter chosen segment |

Held, raised by one judge: Settings' density (Sol).

### Round 4 (November 9, 2026)

Captures: `duo-captures/round-4` (run 42720538255). Scores: GPT-6.1 Sol 9, Claude Opus 5.5 8.5, Claude Fable 5.2 8.5. Fable asked for two reversals, both prototyped and put to Zach.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-5.html`:

| Surface | Pick |
|---|---|
| Which thread, folded (Fable's reversal) | A, the name heads the conversation, quiet, and scrolls away; no bar |
| Below the reply box (Fable's reversal) | As it is, a second time |
| Folded sheets' right side | A, the Agents, pull request and New thread sheets run wide below the clock |
| A running step's command | A, its own line under Running and the timer, a size larger at full strength |
| Reading size sideways | A, a step larger |
| Question choices' circles | A, a stronger ring |
| Below a sheet sideways | B, a darker scrim, glows out behind it |
| Tabs behind the keyboard | A, they step away |
| Where a sidebar name wraps | A, it fills the first line |

Fixed without a pick, each against a decision already made: the folded list's times are short ("2m"), as round 4's prototype said they were; a row waiting in a delegated thread reads Question and the computer; the Agents sheet names a model as the computer does and gives the finished check its room; the ••• card's words start at one edge; the pull request sheet's branch breaks after its slash.

Held, each raised by one judge: Computers sideways (Fable), the New thread sheet's width sideways (Fable), the overview's empty lower half (Opus), the Settings theme grid (Fable).
### Round 5 (November 10, 2026)

Captures: `duo-captures/round-5` (run 42755336243). Scores: GPT-6.1 Sol 9, Claude Opus 5.5 9.0, Claude Fable 5.2 8.5. Fable asked again to end the conversation at the reply box. Zach kept it a third time and on November 10 called it his favourite feature, so from round 8 the brief tells the judges not to score it down or list it as a reversal.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-6.html`:

| Surface | Pick |
|---|---|
| Below the reply box | As it is, a third time |
| Computers | As they are |
| Folded Threads' top | A, the computer menu and search on the title's row |
| New thread sideways | B, two cards to a row |
| The glow in light | A, the same cores with a much tighter falloff |
| A folded row's time | A, it ends the second line |
| The ••• card | A, a step lighter |
| Not now in light | A, an outline pill |
| One-line code block | A, Copy at the code's right end, no header bar |
| Theme grid | A, four across sideways, three folded |

Fixed without a pick, each against a decision already made: a table's columns by their words, ↪ on a wrapped step command, the rail's word and gaps, a card's title filling its first line, the Needs you card's rhythm, a pull request jump landing below the clock, and the page still reading below a sideways sheet.

### Round 6 (November 10, 2026)

Captures: `duo-captures/round-6` (run 42868879865). Scores: GPT-6.1 Sol 9.5, Claude Opus 5.5 9.3, Claude Fable 5.2 8.5. No reversals asked.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-7.html`:

| Surface | Pick |
|---|---|
| State on the rail | B, the word at the sidebar's second-line size, its time for VoiceOver |
| Folded Agents' first label | A, below the clock, only the thread's name beside it |
| New thread sideways | A, as tall as its step, with a floor |
| Scrim in light | A, a neutral near-black at about 55% |
| Send answer dimmed in dark | A, grey until a choice |
| Reply box in dark | B, a step lighter fill |
| Settled on the overview | A, the Recent card's last row |
| Pull request chips | A, no dots |
| Pull request Summary | A, no grey label |
| Answerable card's lines | A, "1 more request" folds into Review |

Fixed without a pick: hiding the sidebar keeps the conversation on its newest turn, one clock for a waiting thread, the Text size track, the New thread sheet's seam sideways, the ••• card's +/− mark, the Tabs setting's wording, the folded list's edges.

### Round 7 (November 10, 2026)

Captures: `duo-captures/round-7b` (run 42890714850). Scores: GPT-6.1 Sol 9.0, Claude Opus 5.5 9.0, Claude Fable 5.2 8.5. Zach chose to make round 8 the last: prototype the open findings on one card, build his picks with the fixes, judge once more, then open the pull request.

Zach's picks, from `docs/prototypes/ios-duo-climb/round-8.html`, every one A:

| Surface | Pick |
|---|---|
| The ••• card's edge | A hairline and a soft shadow, the page undimmed |
| Folded Settings | Tighter, Message density and Tabs on the first screen |
| Folded pull request's top | The state row and chips closer |
| Folded table cards | The title, the short fields on one quiet line, the long field at full width |
| Folded New thread | As tall as its step, with a floor |
| Folded sheets beside the clock | Short headers end on the clock strip's edge, the heading block centred in its band |
| Not now in dark | An outline too |
| The rail's word | 12.5 points, tracked tighter |
| Foot of a sideways sheet | Agents and pull request run to the screen's foot |
| Working cards' first line | No word line: the light starts the name's row, the time ends it |
| Teal against amber | Working cards' glow reaches about half as far |

Fixed without a pick: Review beside Send answer when both fit, folded Watcher's last item above the box with the keyboard up, the sideways Agents subtitle's gap, the question sheet's band above its footer, Watcher's halo clear of its working line.

### Round 8 (November 10, 2026), the last

Captures: `duo-captures/round-8` (run 42912729577). Scores: GPT-6.1 Sol 9.5, Claude Opus 5.5 9.2, Claude Fable 5.2 8.5. No reversals asked. Sol and Fable both found the folded table card's bare "No" (fixed below).

After judging, `main` was merged in (main had given each step pictures and videos at its line's end), and one finding was fixed against Zach's pick: a folded table card's bare answer, number or mark keeps its column's name on the quiet line ("Fixed: No"), where the prototype's values named themselves. `duo-captures/round-8-final` (run 42928343792) is the after of every image in the verification note.

Held as follow-ups, outside this climb: Watcher's reply box shows no Stop while it works; a sideways thread with the sidebar hidden doesn't name itself; Settings' density; the Watch owl's mark, Computers sideways, the Glow slider's dot, short threads sitting high, and the Agents sheet's lines of detail; the sideways sidebar's chosen row with its title in teal (Sol); amber on the pull request sheet's "behind main" and its repeated check count (Opus).
