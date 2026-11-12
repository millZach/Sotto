# An assistant drives Sotto over the tailnet and never answers for the user

## Status

Accepted by Zach on November 11, 2026, on question cards, for Grok Bot. An **Owl feature** (`assistants`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Nothing is built yet; it is the last slices of `docs/plans/2026-11-11-plugins.md`. **Number provisional until merge** (docs/agents/domain.md).

It reopens the decision at the head of `docs/research/2026-10-28-assistants-drive-sotto.md` ("Zach chose not to pursue this"), and builds that note's Design A. It adds a fourth kind of outside client beside a phone ([ADR-0033](0033-the-desktop-lets-paired-phones-reach-its-threads.md)), apps on this computer ([ADR-0180](0180-apps-on-this-computer-connect-without-a-pairing-code.md)) and a team link ([ADR-0186](0186-a-team-link-joins-two-owners-computers-over-a-closed-list.md)), and a second tool surface for threads beside Watcher's ([ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md)). The page it lives on is [ADR-0205](0205-plugins-connect-outside-services-once-and-threads-use-them-through-sottos-tools.md)'s.

## Context

Zach wants Grok Bot to drive Sotto: see his threads and what waits on him, start and steer work, from wherever he talks to it. The October 28 note found that Grok Bot runs only on Cursor's cloud computers and could reach a private Sotto only through a tailnet setup that was Enterprise only, or a public relay, which it advised against; Zach dropped it.

What changed: Tailscale's post of November 9, 2026 (tailscale.com/blog/oauth-apps-ga) says Grok Bot joins the user's tailnet through the Tailscale plugin in its desktop app, "as a device associated with your user identity", and can then reach private MCP servers "without exposing them to the public internet". Zach's account is a personal or Teams plan. Grok Bot's own pages did not yet describe this on November 11, and no page confirms the whole path, including whether a custom server may take a bearer header, so the first slice ends in a live test with his Bot.

The note's findings that still bind: Sotto cannot control what an assistant does with its own approvals, so Sotto's side must refuse by construction; a client holding a `remote-answer` record gets Allow without a further check, so an assistant must never hold one; one-merge-at-a-time is not in code.

## Decision

1. **An assistant is an outside program the user pairs to drive Sotto. Grok Bot is the first and, for now, the only one offered.** It is the user's own, acting at their word; it is not a provider, a paired phone or Watcher. Nothing here is specific to Grok Bot beyond its name and its setup steps, so another assistant is a list entry and its own decision, not a redesign.

2. **It reaches Sotto only on the tailnet.** The desktop serves the **drive tools** as an MCP endpoint on a listener of its own, bound to `127.0.0.1` and carried by Tailscale Serve at its own path, never Funnel and never a relay ([ADR-0088](0088-sotto-leans-on-tailscale.md)). It needs Tailscale running with Serve on, and nothing of phone access. It has its own pairing store, so an assistant never shows as a phone and never counts as one.

3. **It pairs with a code from Settings › Plugins, and the pairing lapses after 30 days.** **Pair Grok Bot** shows an eight-character code, good once and for five minutes, and the tailnet address to give the Bot. Redeeming it gives the Bot its own token; Sotto keeps only the token's hash. The pairing lapses 30 days after it was made or last renewed, as a team link does; **Link again** renews it and **Remove** ends it at once and closes its sessions. The tailnet alone is not proof: the Bot's device carries the user's own identity there, so Sotto could not tell it from any other device of theirs.

4. **The drive tools are a fixed list: read and steer.** List and read threads, read what waits on the user, list projects and machines, start a thread, send to a thread, stop one and settle one. A thread it starts runs in the default mode in a project that already exists.

5. **It can never answer, merge or change a setting, and Sotto is what refuses.** There is no tool to answer a permission, a question or a plugin change's card, to merge or close a pull request, to change policy or a setting, to choose a more permissive mode, to delete, or to use a plugin account. An assistant never gets a `remote-answer` record, and its listener offers none of the host protocol a phone speaks. The refusal is in Sotto's endpoint, whatever the assistant or its own approval settings say. What an assistant sends to a thread is a message like any other: it approves nothing ([ADR-0004](0004-authority-in-policy-records.md)).

6. **Every call is recorded and attributed.** The assistant, the tool, the thread and the time, in the same record a plugin's use is kept in, shown on its row. Never the words sent or read. A refused call is recorded as refused. A message an assistant sends is marked in the thread as from it.

7. **The page says what leaves.** What Grok Bot reads from a thread goes to xAI and Cursor, who run it. The row says so where it is paired, with what it may and may never do.

8. **Owl only.** Stable starts no listener, shows no row and keeps the pairing whole.

## Considered options

- **A public tunnel so Grok Bot works without the tailnet.** Rejected: a door to the user's threads on the internet, against ADR-0033 and ADR-0088.
- **Reports only**, Sotto posting a status to a Grok Bot routine. Not chosen: it cannot steer, and it adds Cursor's routine address as a host.
- **Read only**; **read, steer and merge**; **everything a phone can do**. Zach chose read and steer. Merging would need a merge lock Sotto does not have, and answering cards would have the Bot answering for him.
- **A token that never lapses**, or **the tailnet alone**. Not chosen: an assistant in someone else's cloud holds this token.

## Consequences

- A cloud assistant can read every thread the user has. That is the feature, and it is why pairing is a deliberate act that lapses, and why the row says where the text goes.
- An assistant can start and send, so a prompt it was tricked into sending runs with the thread's own permissions. It still cannot approve what that thread then asks for, which is the line this record holds.
- Sotto gains a fourth listener and a second gate for thread tools. Both are covered by tests that the refused list stays refused.
- No host is added: the listener is on the user's own tailnet. `README.md` says, under "Privacy and cost", that an assistant the user pairs reads their threads.
- If the live test finds Grok Bot cannot send a bearer header to a custom server, the pairing's shape changes (for example an OAuth exchange on the same listener) and this record is amended before more is built.
- Hermes Agent, already a thread provider on Owl, could be offered as a second assistant. That is not decided here.
