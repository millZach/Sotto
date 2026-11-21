# Owlets are named helpers, each one thread in a folder of its own

Accepted by Zach on November 19 and 20, 2026, in the Owlets brainstorms (`docs/plans/2026-11-19-owlets-second-brainstorm.md`, which keeps every answer word for word). He asked for "our own version of grok bot or Hermes called owlets for Sotto", chose the sidebar look and its R2 rows from `docs/prototypes/owlets-sidebar/`, and on November 20 said to start the first slice. **Number provisional until merge** (docs/agents/domain.md).

An **owlet** is a long-lived helper the user names and gives a role, such as "Tawny, keeps my inbox". Underneath it is one ordinary project-bound thread: the same provider tools, cards and permission mode as any thread, in a folder of its own that Sotto makes. Every run is more turns in that one thread. Owlets are an Owl feature, `owlets` in `src/shared/owlFeatures.ts` (ADR-0072): stable shows and starts none of it and keeps its threads whole.

## Decisions

1. **One thread, marked as an owlet.** An owlet is a thread whose record carries `owlet: { name, role }`, Sotto's own record, kept on the thread like Dynamic's mark (ADR-0191). Its model, effort and permission mode are the thread's, changed as a thread's are. So an owlet travels wherever its thread does: the host's store, a restart, the desktop's join of every computer's threads, and later the iPhone.
2. **A folder of its own, in Sotto's data folder** (Zach's pick on November 20). `create-owlet` makes `owlets/<name>` in its home computer's data folder (beside Watcher's own workspace), adds it as a project, and makes the owlet's thread there with a shared working copy. The window shows it as `Owlets/<name>`. ADR-0010 stands: no thread is project-free. A renamed owlet keeps its folder's first name. Two owlets on one computer can't share a name.
3. **One home computer.** An owlet lives on the computer that made it: this computer or a paired host. The command goes to that host by the thread ID the window mints, as other host-qualified commands do. A host that makes owlets lists the `owlets` host feature, only while its own Owl answer is on, and the window offers only those computers. Moving an owlet to another computer is not part of the first slice.
4. **Provider memory is off in an owlet's folder** (Zach's pick on November 20). Claude Code starts there with `autoMemoryEnabled: false` in its flag settings, and Codex with `features.memories` off for that thread, so nothing an owlet reads reaches other threads through a provider's shared memory. Until the notes below arrive, an owlet remembers only its chat. The check is the folder: any thread working in an owlet's folder gets it.
5. **Only providers whose memory is off.** An owlet runs on Claude Code or Codex. Another provider joins `OWLET_PROVIDERS` only once its own memory is known to be off there. Hermes, for one, runs with its memory on in Sotto's launch settings today.
6. **Only on the Owlets page** (Zach's pick on November 20). Owlet threads and their projects are left out of the Threads page: its sidebar, its Needs you card, its project lists and its new-thread project chooser. The Owlets page is a room of its own in the room switch, beside Threads and Watcher. Its sidebar lists every owlet, newest first, each row showing the owlet mark, its name with its role, and its home computer with what it last did (R2). An owlet waiting on the user leads the list under **Needs you**, and one with news nobody has seen carries an unread mark.
7. **The owlet mark** (Zach's pick C of `docs/prototypes/owlet-mark/`, November 20). Each owlet wears a small round owl in lines, with no ear tufts and no fill, so it is kept clearly apart from Watcher's owls, and a face of its own: one of five pairs of eyes and three chests, chosen from its thread ID rather than its name, so a rename keeps it. Colour comes from the theme.
8. **No notification and no push.** Zach chose "Needs you and an unread mark" for hearing about an owlet. Desktop notifications leave owlet threads out.
9. **Separate from Watcher.** Watcher neither sees nor steers owlet threads, and owlets aren't in Watcher's room.
10. **Runs only when asked, in the first slice.** Talking to an owlet is sending to its thread. Schedules and events (CI goes red, a new issue or comment, new mail), the report from a run while away, the lapsed card and a skipped run's line come in the next slice. A card nobody answers lapses as a thread's does (ADR-0205); nothing changes there.
11. **The user answers every permission** (ADR-0004). An owlet never answers its own card, and nothing here answers on the user's behalf. `create-owlet` runs its `create-project` and `create-thread` as the user's own commands, held to the same rules for which permission mode a client may set, so a phone or paired desktop that may not answer for a host can't make a Full access owlet there. They move no selection and announce nothing.
12. **Off, it is dormant.** Where the Owl answer is off, an owlet's thread is a **dormant thread**: shown nowhere and refused work, with its records kept whole.

## The first slice's two parts

1. **The desktop** (this decision's first pull request): the records, the commands, provider memory off, the Owlets page with R2 rows, New owlet and Edit owlet, Needs you and the unread mark.
2. **The iPhone**: an Owlets tab beside Threads that lists the owlets and opens a thread as the Threads list does, answers their cards, and makes and changes owlets (Zach's pick "Also set up and edit"). The iPhone gets owlets from the thread records it already reads.

## Left for later slices

- Schedules and events, with the skipped-run line and the run-while-away report.
- Watcher-style notes (option C of `docs/research/2026-11-19-owlet-memory-open-source.md`): two capped lists, the user's rules and what the owlet found out, given back after compaction. They need their own glossary word and a decision on ADR-0013's gate.
- Removing an owlet and moving it to another computer.
