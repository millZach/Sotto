# Teams: your Watcher and Drake's, talking

Status: first slice approved, November 3, 2026. Settled in a grilling session with Zach on November 2. Zach chose to start it on Owl only, and Drake agreed to open question 1's default. [ADR-0186](../adr/0186-a-team-link-joins-two-owners-computers-over-a-closed-list.md) and [ADR-0187](../adr/0187-another-owners-words-are-untrusted-and-start-nothing.md) hold what the slice decided.

Zach's card, November 3: Teams is a tab beside Watcher (question 9). A teammate's ask is answered by a side call with no tools rather than a Watcher turn, which replaced the planned Watcher turn. Summaries cover every project, with a leave-out list. Two desks and the merge order strip are the next slice. Open question 2 has no hold card, because an answer never sees thread content (ADR-0187, decision 3). The plan's links still say what it knew on November 2; #1691 and #1692 are as it says.

## What it is

Two owners, Zach and Drake, each run Sotto on their own computers. A teams link lets the two Watchers talk, so the two of them can coordinate: merge priority, and what the other is working on. Shared work comes in a later slice, in each owner's own checkout.

## What it builds on and collides with

- **Host links (ADR-0105)** connect one owner's own machines. A link adds no grant, a linked machine may start only threads it started, and "nothing a linked machine sends answers anything." This is the closest existing model. A teams link is the same shape with a different owner.
- **Pairing (ADR-0025, ADR-0033, ADR-0053).** A paired desktop gets a `remote-answer` policy on the host. Code and phone pairing get no default authority.
- **#1692 (open).** Paired tokens never expire (`src/main/agents/pairing.ts:139-155`). The 12-hour session renews them, and only revoke stops one. The fix needs an ADR amending ADR-0025 and ADR-0053.
- **#1691 (closed) is fixed by #1741**, merged October 29: a paired client's merge, close or auto-merge needs the host's confirmation receipt.
- **Watcher (ADR-0073, CONTEXT.md).** One per computer. Its news "grants no permission." #1217 (open) asks that Watcher not message a delegated child, which it does today. Standing watches, Settle and the merge queue are in CONTEXT.md. `watcherPairedHosts` is not in the code; paired-host Watcher logic is in `src/main/agents/watcher.ts`.
- **Authority (ADR-0004).** Permission and question answers belong to the user. Supervision never answers. AGENTS.md requires an ADR before anything answers on the user's behalf.
- **Privacy (README, AGENTS.md).** "Sotto has no account of its own." A feature that adds a host, or sends what the user said elsewhere, needs an ADR and a README change first. A teams link is both.
- **Usage (README).** Each thread runs on its owner's own provider account. The OpenRouter key is used only for cleanup (ADR-0069).
- **Merging.** AGENTS.md's merge rules already handle several agents merging into `main`. Merge priority between two Watchers is the same problem one level up.

## Comparable products (primary docs)

- **Claude Code agent teams** (https://code.claude.com/docs/en/agent-teams). One lead and its teammates, all one person's sessions. A teammate can message another by name. A message from another agent is "from another Claude session, not from you," and a teammate "can't approve a permission prompt or supply consent on your behalf." Experimental.
- **Claude Code cross-session messaging** (https://code.claude.com/docs/en/cross-session-messaging). An incoming message "can't approve anything," can't change configuration, and commands in it do not run. Messages between machines go through Anthropic's servers and need the same claude.ai sign-in.
- **Zed channels** (https://zed.dev/docs/collaboration/channels). The host's project is what is shared. Guests can view and hear. Write access is granted per call by the host. Unsharing disconnects collaborators.
- **Cursor cloud agents** (https://cursor.com/docs/cloud-agent). Shared as a link to team members only. A viewer needs their own repo access. Viewing is read-only unless an admin enables follow-ups. The run uses the starter's repo rights.
- **The pattern.** Work stays under one owner's machine and rights. Others get a view or a narrow grant. A message from another person or agent is data, never consent. GitHub Copilot's approval rules are not used here, since the docs page fetched did not state them.

## Decisions (Zach's picks, November 2, 2026)

1. **Who is on a team.** "You and Drake": two owners who already trust each other.
2. **What your Watcher can reach on your computer.** "Talk only." Drake's Watcher starts, stops, sends to, settles and changes nothing on your side.
3. **What crosses between the Watchers.** Its own words, and summaries. Zach, after the first answer: "It doesn't need to open a thread. This is more meant to be directly in the watcher thread. As a first slice what I imagine is saying something along the lines like coordinate merge priority with drakes watcher so we aren't stepping on each others toes or give me a list of what Drake is working on for Sotto." Opening threads to the other person is out of the first slice.
4. **How the two computers connect.** "Direct over a tailnet," set up by one press each way, as host links are. A relay that Sotto runs is not chosen; it would add a host and an account. (Built as one code that links both directions, because host links' setup needs an SSH sign-in on the other owner's computer: ADR-0186, decision 3.)
5. **How far a message from Drake's Watcher reaches.** "Show and read only." Its asks become cards you answer. (Not in the first slice: an ask makes no card. A side call with no tools answers it, and it shows as a teammate's message: ADR-0187, decisions 1, 2 and 4.) The action tools (send, stop, settle, watch, start) refuse anything a teammate's message triggers, enforced in code, not only in the prompt. ADR-0073 treats a prompt rule as guidance only. Nothing in a message answers a card or grants a permission.
6. **Where shared work happens (later slice).** "Own checkouts, branches move." Each owner works in their own checkout. Branches move over the link, as ADR-0082 does between one owner's machines. Nobody edits the other's checkout.
7. **How much flows by default.** Zach, after the question on pressing Send: "We need to be very careful with this we don't want to be sending a ton of data back and forth." Chosen: "Only when someone asks."
8. **Whether asks show before they go.** "Send at once." Zach's request is the go-ahead.
9. **What it looks like.** A Teams pane with its own owl art and Drake's status, which opens into two desks: yours and Drake's side by side, with the merge order across the top. Zach: "Yes but give me a prototype that looks like the actual app." The prototype uses Sotto Dark's colours and the app's Figtree font.
10. **How long the link lasts.** "Fixed period, re-pair": 30 days by default. Both sides re-pair with one press. The Hosts page shows when each link was last used. This is also the direction #1692 needs.

## Decided by the above (not asked; for Zach to object to)

- **Merge priority is advice.** It orders work and merges nothing. Each owner still merges their own PRs under their own confirmation (#1741, ADR-0004).
- **Usage lands on the receiving side.** A teammate's ask runs on your provider account: first planned as a turn in your Watcher, then a side call with no tools (ADR-0187, decision 2). Each owner's work runs on that owner's account (README).

## Open questions

Each has a recommended answer.

1. **Drake's sign-off on what his Watcher shares.** Drake's computer decides what his Watcher answers. Recommended: Drake sets this on his own computer. The default is summaries of his own threads. This needs Drake's yes.
2. **Your Watcher's own replies.** Decision 8 covers your asks. Your Watcher also writes replies, which may quote thread content. Recommended: show a reply that quotes thread content before it goes.
3. **A cap on how many turns a teammate's message can start.** Recommended: a small daily cap, and a stop when the two Watchers keep asking each other. Cross-session messaging already throttles loops this way.
4. **Starting work on the other's machine (later).** Recommended: each start waits for approval, as linked starts do under ADR-0105. Acting without asking would need an ADR and a policy record.
5. **Merging a branch that crossed over (later).** Recommended: the receiving owner merges it under their own confirmation. No auto-merge without an ADR.
6. **Collisions in shared work (later).** Who claims a file, and how branch names are chosen. Recommended: each owner says which files they are changing over the link, and no one edits the other's checkout.
7. **Owl or stable.** CLAUDE.md asks this before building a new feature. Not asked yet.
8. **New words.** "Teams" for the pane, "teammate's Watcher," and "merge priority" are new. Add them to CONTEXT.md when building. Check "teams" against any existing sense in CONTEXT.md first.
9. **Where Teams sits.** Drawn as a tab beside Watcher in the room header. The bottom dock holds Dictate, Watcher and Threads. Zach may prefer a dock button.
10. **Scope of #1692.** Does the 30-day rule cover phones and every paired desktop, or only teams links? Recommended: all paired clients, as a separate PR with an ADR amending ADR-0025 and ADR-0053.

## Needed before code

- **ADR:** a teammate link as a new host kind. It amends ADR-0105, which covers only the owner's own machines, and ADR-0025 and ADR-0053 for pairing.
- **ADR:** messages from another owner's Watcher are untrusted input, and action tools refuse them. Amends ADR-0073 and ADR-0004.
- **README, "Privacy and cost":** Drake's computer is a host Sotto contacts. Name it there with its reason.
- **CONTEXT.md:** the new words in open question 8.

## Suggested first slice

"Two Watchers talk, and nothing else."

- Behind an Owl feature flag, once open question 7 is answered.
- Link two desktops with a code on a team link of their own (ADR-0186, which replaces reusing host links' setup), with the 30-day expiry. Tests can use the laptop and forge as the two computers.
- Your Watcher can send one kind of message to the linked Watcher: an ask. The reply comes back in your Watcher's conversation, shown as a teammate's message.
- Two asks: coordinate merge priority, and list what the other is working on.
- No thread content, no starts, no stops, no approvals, no merges.
- Tests: a teammate's message cannot trigger any action tool, enforced in code. Nothing is sent without an ask (a count test). The link refuses any command outside its closed list.
- Verify in the running app on both computers, and screenshot the Teams pane.

## Prototype

The prototype is throwaway and kept outside git, in `/home/zach/.sotto/prototypes/teams-look/`. Its files are `index.html` (three layouts, A to C, plus the first Teams pane) and `app.html` (the Teams pane and two desks in the app's own look). When the look is final, keep it as a `prototype/` tag, as the prototype skill describes.
