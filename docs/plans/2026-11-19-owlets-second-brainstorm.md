# Owlets, a second brainstorm

November 19, 2026. Zach asked for a second brainstorm thread, on Opus 5.5, for Owlets: "brainstorm our own version of grok bot or Hermes called owlets for Sotto." The first brainstorm ran on GPT-6.2-Sol: `docs/plans/2026-11-19-owlets-brainstorm.md` in thread `4b307019`. Its prototype is at `https://forge.tail5728ca.ts.net/owlets-brainstorm/owlets-page-prototype.html`. This note keeps that thread's research and Zach's recorded answers, and brings its own take where it differs. Nothing here is decided until Zach's answers below say so.

This is a brainstorm. It builds nothing and opens no pull request.

## Where this differs from the first brainstorm

1. **Its first slice is something a thread already does.** Plugins is on stable, so any thread can read a mail account once it has a **mail grant**, draft a reply and ask to send it with `mail_send` on a card. The first brainstorm's slice (ask an Owlet to triage one inbox, get a draft, approve the send) adds a name, a role and a page to that. It doesn't add work Sotto can't already do.
2. **What Grok Bot, Devin and Hermes add is work that runs while you're away.** All three run jobs on a schedule or an event, and a result is waiting when you come back. That is the part that makes a helper feel like a bot rather than a chat. It is also where Sotto's own rules bite hardest: nobody is there to answer a card, the iPhone alerts only while Sotto is open on it (ADR-0051, no Apple push), and an unattended run is the easiest place to hide a mistake.
3. **An Owlet reading mail is reading text that strangers wrote.** Mail is a prompt anyone can send. An agent that holds private data, reads untrusted text and has a way to send data out is the standard recipe for a leak. So which tools an Owlet gets matters more than which tools a thread gets, and the first brainstorm left it as "narrowly scoped tools enforced by Sotto" without saying how. Sotto can fence some providers' own tools today (Claude Code's disallowed tools, Codex's read-only sandbox) and not others.
4. **Sotto retired project-free chats six weeks ago.** ADR-0010's personal chats were removed on October 6, 2026. An Owlet with no project is that idea back. One way through: an Owlet's home is a folder of its own that Sotto makes, so underneath it is still a project-bound thread and none of the thread invariants bend.
5. **"Owl" is already busy.** Sotto Owl is the preview track, an Owl feature is a held feature, and Watcher's room draws an owl for each watched thread (the owl family). "An Owlet in Owl" and "the owlet over that watched thread" are both easy to say and mean different things. The glossary entry has to settle this before any build.

(This list grows as Zach answers.)

## What the references do

Read from each product's own documentation by the prototype agent (Fable 5.2, xhigh), as text. Nobody here has seen their screens.

- **Grok Bot (xAI).** Named Bots, each with a job, share one cloud computer: its files, its sign-ins and its skills. Each Bot has a screen you can watch. A routine belongs to one Bot, with when it runs, an instruction, the next run, an on switch, **Run now** and a run history. The phone app lists the Bots, opens a Bot's screen from the chat and asks for approvals. A primary Bot coordinates the others, and Auto Review and "Always allow" rules let a Bot act without asking. Sources: [x.ai/bot](https://x.ai/bot), [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works), [Bots](https://docs.x.ai/grok-bot/bots), [Skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Approvals, security and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy), [Mobile](https://docs.x.ai/grok-bot/mobile).
- **Devin Bots (Cognition).** A real product, announced November 17, 2026. A Devin Bot owns an *outcome* rather than a task ("main stays green"). It starts a Devin session for each piece of work, and everything that needs a person gathers in one **Needs you** list: approvals, decisions with the Bot's suggestion marked, and reports. Work is grouped by state. Triggers are a time or an event, each with its own switch ("automations"; Devin's older scheduled sessions are now called legacy). Each Bot has a usage limit. Sources: [Introducing Devin Bots](https://devin.ai/blog/introducing-devin-bots), [Devin Bots docs](https://docs.devin.ai/work-with-devin/bots), [Access and security](https://docs.devin.ai/work-with-devin/bots/access-and-security), [Usage limits](https://docs.devin.ai/work-with-devin/bots/usage-limits), [Automations](https://docs.devin.ai/product-guides/automations).
- **Hermes Agent, Bot Mode (Nous Research).** A bot is a profile with its own role, model, memory and skills. It has one main chat that is pinned and never restarted, and every other run is a tab beside it. Schedules are written in plain words and read back before they start. A routine's report lands in the bot's own chat, and it says nothing when there is nothing to report. Its memory is small and bounded. It keeps skills it wrote itself unused until you keep them. A gateway reaches it from chat apps. An approval nobody answers in five minutes lapses. Sources: [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security).

All three **run work while you're away**, keep **a role and a memory per bot**, and **gather what needs you in one place**. Two of them, Grok Bot with "Always allow" and Hermes with "always" and YOLO, also let a bot act without asking, which Sotto doesn't allow (ADR-0004).

## Three looks (prototypes)

Built by Fable 5.2 on xhigh at Zach's request. They're served at https://forge.tail5728ca.ts.net/owlets-looks/ (`?variant=A`, `B` or `C`, and `&theme=light` for light) and kept in `docs/prototypes/owlets-looks/`. All three use the same made-up owlets: Tawny (inbox, This computer), Scops (repo upkeep, forge), Elf (morning brief, forge) and Barn (receipts, This computer).

- **A · after Grok Bot: computers and screens.** Owlets are grouped by the computer they live on, and each has a screen showing what it has open. The page says plainly that owlets on one computer share its plugin accounts and files. An owlet opens on its chat beside its screen, with routines and shared skills as tabs.
- **B · after Devin Bots: outcomes and Needs you.** Each owlet owns a one-sentence outcome. The page opens on every card waiting for you across all owlets, answerable in place, with "What each one owns" beside it. An owlet opens on its work grouped as Needs you, Working, Up next and Done.
- **C · after Hermes Bot Mode: one long chat on the branch.** The owlets sit on a branch drawn in text characters, as Watcher's owls do, and their eyes show their state. Each has one chat that is never started over, with runs as tabs beside it, routines docked in plain words, and seven pages for what it is.

The three handle a card nobody answers while you're away differently, on purpose. In A it waits. In B it stays in Needs you. In C it lapses after five minutes, as a thread's card does today (ADR-0205).

The first brainstorm's three layouts were one arrangement, a list beside a chat or feed, shown three times. None of them showed the home computer, model, card, report, setup or phone.

### The sidebar look

After Zach asked for a sidebar, Fable 5.2 on xhigh built it at https://forge.tail5728ca.ts.net/owlets-sidebar/, kept in `docs/prototypes/owlets-sidebar/`. Every owlet sits in one sidebar on the left, with search and an add button, and the selected owlet's thread fills the rest, as on the Threads page. It shows a report from a run while away with a skipped run and a lapsed card, a live card, setup, and the iPhone list. Three row variants were offered: R1 quiet (name and state dot), R2 two lines, and R3 grouped by state. Zach picked R2.

The agent stopped before it wrote its report, so its last round of checks was not finished and nobody else has looked over every screenshot. Its screenshots are in `.zstack/owlets-proto/sidebar/shots/`.

## What Sotto already has

- **Threads with Plugins.** GitHub, Vercel, Gmail, Proton Mail, Meshy and ElevenLabs, through Sotto's tools, with reads free and every change asking on its card (ADR-0205). A mail grant is per thread, until stopped.
- **Watcher.** One coordinating thread per computer that starts, watches and steers threads, and answers none of their cards (ADR-0073).
- **Delegation.** A thread can hand work to threads it starts, two levels deep (ADR-0081). A Dynamic thread's overseer hands every piece out (ADR-0191).
- **Worker roles.** Named kinds of work with a model, effort and permission (ADR-0091). Close to an Owlet's "role", but they're defaults for starts, not standing helpers.
- **Schedules Sotto already keeps.** Restarts at a provider's reset (ADR-0144), the idle clock, Keep main up to date's 15-minute fetch, and babysitting. Nothing yet runs a prompt at a time the user picked.
- **Paired hosts.** forge is always on, holds its own sign-ins and receives account copies of plugin accounts (ADR-0205's amendment of ADR-0025). The laptop sleeps.
- **Reaching the user.** Mac notifications, and iPhone alerts only while the app is open.
- **Assistants.** ADR-0206 lets an outside assistant such as Grok Bot drive Sotto over the tailnet without ever answering anything (#2501, #2502, open). That is the other direction: their bot driving Sotto. Owlets are Sotto's own.

## Open questions

- **The notes' name and ADR.** They need a glossary word that isn't "memory", and an ADR on whether they sit outside ADR-0013's gate, as Watcher state does.
- **Sending a lapsed change later.** A run while away ends with the card lapsed and says what it wanted to send. How the user sends it later is open; telling the owlet "send it", which asks again on a new card, is one idea.
- **Events beyond the first three.** CI goes red, a new issue or comment, and new mail are in. Vercel deploy failures were left out; nothing else has been decided.
- **Full access with new mail.** Zach kept "Whatever the owlet is set to", so a Full access owlet started by a stranger's email runs shell commands without asking. The notes' mail rule covers only Sotto's own tool, not the provider's file and shell tools. Worth a second look before events ship.
- **The glossary entry.** "Owlet" has to be told apart from Owl features and the Owl track in `CONTEXT.md`.

## Zach's answers

### From the first brainstorm (thread 4b307019), as recorded there

- **Identity and surface:** "It will be its own page and will be similar to grok bot so research that"
- **First job:** "Research grok bot and hermes then ask me questions"
- **Release track:** "Start in Owl (Recommended)"
- **Starting capability:** "Work across apps (Recommended)"
- **Home:** "Pick one computer (Recommended)"
- **Layout:** "A · Chat first (Recommended)"
- **Workflow:** "Triage one inbox (Recommended)"
- **Trigger:** "When I ask (Recommended)"
- **Action limit:** "Ask and make changes"
- **Reach:** "Desktop and paired iPhone (Recommended)"
- **Watcher and threads:** "Separate to start (Recommended)"
- **Continuity:** "Role and chat (Recommended)"
- **Mail read permission:** "Until I revoke (Recommended)"
- **Model:** "I choose per Owlet (Recommended)"

### In this thread

- "Before asking me questions have fable 5.2 on xhigh come up with three prototypes with how owlets will look. Use grok bot, Devin bots, and hermes bots as examples"
- **Look** (asked with A, B and C open): "I kind of prefer just a side bar that has all the owlets in one bar on the left with a main thread window for them. Easiest to manage and add as many as you like"
- **A card while you're away:** "Lapses in 5 min, as now". No change to ADR-0205: a change nobody answers in five minutes sends nothing, and the owlet says what it wanted.
- **Trigger:** "Schedule and events". This replaces "When I ask" from the first brainstorm.
- **Tools:** "Same as a thread". An owlet gets its provider's full tools under its permission mode, as a thread does.
- **Where its thread lives:** "A folder of its own". Sotto makes a folder for each owlet, so it stays a project-bound thread and ADR-0010 stands.
- **A scheduled owlet's computer:** "Any computer, skips when asleep". A run due while its computer sleeps doesn't happen, and the next report says it missed one.
- **A prototype of the sidebar layout:** "Yes, on Fable 5.2 xhigh".
- **Events in the first version:** "CI goes red, New issue or comment, New mail". Vercel deploy failures are left out.
- **Permission mode for a run nobody started:** "Whatever the owlet is set to". Asked after pointing out that a Full access owlet started by new mail runs shell commands unasked.
- **Hearing about a run while away:** "Needs you and an unread mark". No notification and no push.
- **A limit on runs:** "No limit".
- **How runs sit in its thread:** "All in its one thread". Every run is more turns in the same long chat.
- **Memory between runs:** "We should research how other open source projects do agents and handle memory"
- **What memory to use** (asked with the four options in [the memory research](</home/zach/.sotto/thread-worktrees/1cc5ffa0-2e97-4c27-9587-5db10ca8b21e/docs/research/2026-11-19-owlet-memory-open-source.md>)): "C. Watcher-style notes (suggested)". An owlet keeps two capped lists, as Watcher keeps its state. One holds the user's standing rules for it, in the user's words. The other holds what it found out, each line marked with the run and the kind of source it came from. A rule is kept only in a run the user started. A run that read mail keeps only lines marked as found in mail. Sotto gives the lines back after each compaction, and the user can see and edit them. It needs an ADR and a glossary word other than "memory".
- **First slice:** "Page and setup only". Runs happen only when asked, and schedules and events come in the next slice.
- **Naming:** "Keep Owlets, and draw them". Owlets keep their name and get an owl mark of their own, kept clearly different from Watcher's room owls. The glossary entry still has to separate them from Owl features and the Owl track.
- **iPhone:** "Also set up and edit". The paired iPhone can talk to owlets, answer their cards, and make and change them.
- **Watcher:** "Fully separate". Watcher neither sees nor steers owlet threads, and owlets aren't in Watcher's room.
- **Sidebar rows** (asked with R1, R2 and R3 open): "I like R2, so that is what I would choose". Each row shows the owlet's own mark, its name with its role beside it, and under them its home computer and either what just happened or its next run. Newest first, as Recent is on the Threads page.
- **The provider's own memory in owlet folders:** "Off in owlet folders (suggested)". Claude Code's auto memory, Codex's memories and any other provider memory are off in an owlet's folder from the first slice. Until the notes come, an owlet remembers only its chat, and nothing it reads reaches other threads through a provider's shared memory.

- **Building** (November 20): "I am fine with you starting to build go for it". The first slice is built in this thread, the desktop first and the iPhone second (ADR-0210).
- **Threads page, folder and providers** (asked while building): "Only on Owlets (suggested)", "In Sotto's data folder (suggested)" and "Only where it's off (suggested)".
- **The owlet mark** (asked with `docs/prototypes/owlet-mark/` open): "Draw it now (suggested)", then "C · Each its own face (suggested)".

## Suggested first slice

A suggestion for Zach to accept or change, shaped by his pick "Page and setup only".

1. **An Owl feature** in `src/shared/owlFeatures.ts`, as the first brainstorm chose.
2. **The Owlets page** with the sidebar look and R2 rows, on the desktop and the paired iPhone.
3. **Setup and edit:** name, role, home computer, model, permission mode, plugin accounts. Sotto makes the owlet's folder (`Owlets/<name>`) and its one project-bound thread, so ADR-0010 stands. The provider's own memory is off in that folder.
4. **Runs only when asked.** Talking to an owlet is more turns in its one thread, with the same tools, cards and permission mode as any thread.
5. **Needs you and an unread mark** for an owlet with a card waiting or news unread. No push.

Left for the next slices: schedules and events (with the skipped-run line), the run-while-away report and lapsed card, Watcher-style notes with their ADR, and the owlet mark.

## Follow-ups outside Owlets

- **Apple push for the iPhone.** The iPhone hears of a card only while the app is open (ADR-0051). Owlets that run while you're away would gain most from push, but it is its own decision.
- **Memory leaving the beta gate.** Option D in the memory research waits on ADR-0013. Watcher-style notes don't, but the gated memory store is still the richer design if Memory ever leaves the beta.
- **The preview port range is full.** The checkpoint script's range (8071 to 8199) had no free port, so the prototypes used a copy on 8310 to 8399. The checkpoint skill's range or its cleanup needs a look.
- **Codex's shared memory pool.** With Codex memories on, every Codex thread on a computer shares one pool, so what one thread read in a stranger's email can reach the others. That matters for threads today, not only owlets.
