# Plugins connect outside services once, and threads use them through Sotto's tools

## Status

Accepted by Zach on November 11, 2026, on question cards and against the prototype `docs/prototypes/plugins-settings-prototype.html`. He asked for "plugins for the app that give agents a known place where things are connected", with its own tab in Settings. An **Owl feature** (`plugins`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Nothing is built yet; `docs/plans/2026-11-11-plugins.md` is the build in slices. **Number provisional until merge** (docs/agents/domain.md).

It amends [ADR-0025](0025-headless-host-and-client-identity.md), which says a paired client may not send a credential: the desktop now sends a plugin account's secret to the user's own paired hosts (decision 4). It adds standing exceptions to "the user answers every permission" of the kind [ADR-0029](0029-a-thread-uses-the-browser-without-asking-by-default.md) says need their own record (decisions 7 and 8). It widens "One key" in `AGENTS.md`: each plugin account is a secret Sotto holds. Each plugin adds hosts, so each gets its `README.md` entry in the pull request that builds it. [ADR-0141](0141-a-thread-makes-3d-models-with-meshy-and-asks-before-each.md)'s Meshy decision stands and is built as a plugin; where the two disagree on where the key is entered and whether it is copied, this record wins. ADR-0141 also says a host's threads always ask and that each computer counts its own credits; for a copied account decision 4 replaces both. Grok Bot, which drives Sotto and is not a service agents use, is [ADR-0206](0206-an-assistant-drives-sotto-over-the-tailnet-and-never-answers.md).

## Context

A thread's agent that needs Vercel, mail or a paid media service today finds whatever the shell happens to hold: an environment variable, a CLI's own login, a key in a file. Nothing says which accounts exist, nothing asks before a deploy or an email, nothing is recorded, and the agent holds the secret itself. The same accounts have to be set up again on every computer that runs threads.

What Sotto already has: a credential store only main reads, encrypted by the operating system, where the window learns only "saved" (`src/main/agents/credentials.ts`); a paired host with its own encrypted file and key file (`src/host/credentials.ts`); tool servers on loopback with one token per thread, which Claude Code, Codex, Grok Build, Muse, OpenCode and Pi take with no adapter change, and Devin once its list of Sotto's servers names the new one (`src/main/agents/threadToolServer.ts`, `devinPolicy.ts`); and tool calls that wait on the user's answer in Sotto, as the browser and the cloud iPhone do. The closest built precedent for a paid outside service is the cloud iPhone's run.cloud key ([ADR-0047](0047-a-cloud-iphone-runs-on-run-cloud-and-asks-before-each-session.md)); Meshy (ADR-0141) is decided and not built.

The services' own facts, read from their documentation on November 11, 2026, are in the table under decision 2. The options Zach was shown and did not choose are under Considered options.

## Decision

1. **A plugin is an outside service from a fixed list; an account is one sign-in to it.** Sotto ships the list: GitHub, Vercel, Gmail, Proton Mail, X, ElevenLabs, Higgsfield and Meshy. The user adds an **account**, names it (Work, Personal), and may add several to one plugin. There is no way to add a service that is not on the list, and Sotto loads no third-party plugin code: "plugin" here is Zach's word for a service Sotto knows how to reach, not an extension mechanism.

2. **Each plugin signs in the plainest way its service allows a single person.**

   | Plugin | Sign-in | Hosts | Cost and terms the page must say |
   |---|---|---|---|
   | GitHub | The `gh` command's own sign-in on each computer ([ADR-0027](0027-git-the-way-t3-code-does-it.md)). Sotto stores nothing and copies nothing. | Those `gh` already reaches | Free |
   | Vercel | A token the user pastes | `api.vercel.com` | Free API |
   | Gmail | The address and an app password, over IMAP and SMTP. Needs 2-Step Verification. | `imap.gmail.com`, `smtp.gmail.com` | Free. Google gives an app password the whole mailbox; Sotto's tools are what limit it. |
   | Proton Mail | Proton Mail Bridge running on the same computer: the Bridge address and Bridge password | `127.0.0.1` only (Bridge's own ports) | Needs a paid Proton plan with Bridge |
   | X | Sign-in in the browser (OAuth with PKCE, no client secret) | `api.x.com`, `x.com` | Paid per call, reads included. X's rules want automated accounts labelled. |
   | ElevenLabs | A key the user pastes | `api.elevenlabs.io` | Paid by use. May train on what is sent unless turned off in the ElevenLabs account. |
   | Higgsfield | A key ID and secret the user pastes | `api.higgsfield.ai` | Paid from a prepaid balance. May train on what is sent. |
   | Meshy | A key the user pastes | `api.meshy.ai`, `assets.meshy.ai` | Paid by the credit, as ADR-0141. May train on what is sent. |

   Host names not confirmed on a vendor page (Gmail's, and Higgsfield's console) are confirmed in the slice that builds the plugin, and that slice adds the plugin's `README.md` entry under "Privacy and cost". A plugin whose slice finds a fact here wrong amends this table with the date.

3. **Secrets live in Sotto's credential store, one slot per account, and are never shown again.** Main alone reads them. The window gets "saved" and the date, and offers **Replace**. No secret reaches a renderer, a log, a product event, an agent, a phone or a plain file. An account's name and address are the user's own details: they stay out of logs and product events ([ADR-0179](0179-sotto-sends-product-events-unless-turned-off.md)) too.

4. **An account added on the desktop is copied to the user's own paired hosts. This amends ADR-0025.** ADR-0025 said "a paired client may not send a credential, and the desktop's key never leaves it", so a host's keys were typed on the host. For plugin accounts, and only for them:
   - The desktop sends an account's secret and settings to each paired host over the connection it already holds to that host, and the host keeps it in its own encrypted credential file. This is an **account copy**.
   - **Copy new accounts to every computer I pair** is on by default. Each account has a switch per host that stops or starts its copy. A host that is not connected gets the copy when it next connects, and the page says it is waiting.
   - Only the desktop that set a host up may send one: the client that holds that host's desktop grant (ADR-0025's September 29 amendment). A phone, an app on this computer ([ADR-0180](0180-apps-on-this-computer-connect-without-a-pairing-code.md)), an assistant (ADR-0206) and a team link ([ADR-0186](0186-a-team-link-joins-two-owners-computers-over-a-closed-list.md)) can neither send nor read one. A host never sends a secret back.
   - Removing an account removes every copy; a host that is not connected removes its copy when it next connects, and the page says so until it has. Replacing a secret replaces the copies.
   - A host with no key file cannot keep a copy, and the page says so for that host, as it does for a host's own keys today.
   - **One limit and one switch, wherever the account is.** A monthly limit is one figure for the account: the desktop and each host holding a copy report what they spent to each other while connected, and a host that cannot reach the desktop keeps to what was left when it last heard. An **Ask before each** switch turned off on the desktop applies to a host's threads too. A request from a host's thread reaches the user as that host's requests already do.
   - Every other credential keeps ADR-0025's rule: the OpenRouter and run.cloud keys and provider sign-ins are still never sent.

   Zach chose this over typing accounts in again on each computer, and over the desktop answering a host's calls, because forge runs threads while the laptop is closed.

5. **An agent reaches a plugin only through Sotto's tools.** One tool server, `sotto_plugins`, served the way Sotto's other tools are, to every provider that takes them, on the desktop and on a host that holds copies. Sotto makes the call with the secret and hands back the result. No secret is put in an environment variable, a config file or an agent's hands, and there is no `sotto` command for it. An agent's own shell is unchanged: where `gh` or another CLI is signed in on the computer, the agent can still run it as it can today, and nothing here claims otherwise.

6. **Reads go through one tool; every change is its own named tool.**
   - `plugin_accounts` lists the plugins and accounts this thread may use, by name.
   - `plugin_read` reads from any part of a plugin's API: a `GET` to that plugin's hosts and no others, with the secret added by Sotto. For GitHub it is `gh api` with `GET`. A short refuse list per plugin covers reads that hand back other secrets (Vercel's decrypted environment variables, token lists). Mail has no HTTP API here, so for a mail account the same tool takes a search or a message to open in place of an address.
   - A **plugin change** (anything that sends, posts, deploys, deletes or spends to make something; a read is never one, even where the service charges for it) is a named tool with typed arguments, such as a preview deploy, sending an email or making a 3D model. A change with no named tool cannot be made through a plugin until one is added.

   Named changes are what let a card say in plain words what will happen ([ADR-0185](0185-a-permission-card-shows-readable-words-not-raw-input.md)); a card that showed a method and an address would not.

7. **Reading never asks; a change asks each time; a few changes have a switch.** Sotto holds a change's tool call until the user answers a card that names the thread, the account and what will happen, in the way the browser's and the cloud iPhone's requests wait today. It counts in **Needs you**, only the user's explicit choice answers it, and nothing reaches the service before that. Spending, publishing and destroying are ADR-0004's risk classes and are checked as any risky action is.
   - **Always ask, with no switch:** sending an email, deleting or moving mail, posting on X, a production deploy, deleting anything, merging on GitHub.
   - **Ask before each, a switch on the account, on by default:** a preview deploy (Vercel); a sound (ElevenLabs), a video (Higgsfield) and a 3D model (Meshy), each bounded by the account's monthly limit as ADR-0141 bounds Meshy's.
   - Turning a switch off is a standing grant the user makes: it reaches only that account and that kind of change, only up to the limit where there is one, every use still shows in the thread and in the record, and turning it back on ends it at once. A memory, a repetition or a provider's confirmation never turns one off.
   - Paid reads (X charges for them) do not ask but count against the account's monthly limit, and Sotto refuses a read that would pass it.

8. **Mail: each thread asks once before it reads an account.** What a thread reads goes to that thread's provider, so the first read of a mail account by a thread waits on a card that names the account and the provider. The answer is a **mail grant** for that thread and that account, until the user stops it or the thread is settled. It covers searching and reading, never sending.

9. **An account works in every thread, and a project can narrow it.** Each account has an on switch. By default every thread on every project may use it; an account can instead be limited to chosen projects, so a work project never touches a personal account. Watcher gets the reading tools only: it can list accounts and read from a plugin, such as a deploy's status, and has no tool that makes a change. It starts or steers a thread for that, as it does for other work.

10. **Sotto keeps a record of each use, without its content.** It was part of the choice Zach made for decision 5 ("Sotto can ask you first and keeps a record") and is the **Recent use** list in the prototype he picked from. The thread, the account, what was done in plain words, how it was answered and when. Never message text, addresses, file contents or what a read returned. It follows Keep local history and forgetting a thread, and the account's page shows the recent ones.

11. **Settings › Plugins is one list.** Zach's pick A of three: every plugin is a row, grouped (code and deploys, mail, 3D models, sound and video, posting, assistants that drive Sotto), in the manner of Providers, and a row opens in place to show its accounts, each with its settings. A plugin's row shows the service's own icon, drawn in one colour from the theme as a provider's mark is (`ProviderMark.tsx`). The page sits after Providers. An **Other computers** group holds the copy default and says which hosts hold copies.

12. **Each plugin sits behind one adapter in main that imports nothing from Electron**, so the host runs the same code, and speaks to its service with Node's `fetch` or sockets: no vendor SDK and no new runtime dependency ([ADR-0018](0018-terminals-run-on-node-pty.md)). Everything else addresses an account by Sotto's own ID.

13. **Owl only.** Stable shows no page and serves no plugin tools, and keeps accounts, copies and records whole, so a return to Owl finds them.

## Considered options

- **Where secrets live.** Each computer its own, as ADR-0025 has it (rejected: every account typed in on every computer). The desktop keeps them and answers a host's calls (rejected: forge's threads would lose plugins while the laptop is closed). One operating-system keychain entry per account (rejected: a native dependency, which ADR-0018 says needs its own ADR).
- **How agents reach a plugin.** Environment variables (rejected: every agent would hold every secret, and nothing could ask first or record). Tools plus a per-plugin switch that also sets a variable (not chosen). A `sotto` command (not chosen: a new program to ship and keep on `PATH`).
- **Tool shape.** The whole API through one tool, changes included (rejected: a change's card would show a method and an address). Named tools only (rejected: slow to build, and agents could read only what was listed).
- **Watcher.** No plugin tools, or every tool as any thread. Zach chose reads only.
- **A limit on a copied account.** Each computer counting its own, as ADR-0141 did. Zach chose one limit across computers.
- **Asking.** Every change always asks with no switches; a switch for every plugin, email and X included; each thread asks once per plugin. Zach chose reads free, changes asking, and switches only where a limit or a preview bounds the harm.
- **Gmail.** Google sign-in with the user's own Cloud project: Google itself would enforce read-only against send, but the sign-in lapses every 7 days while the project is in Testing. Not chosen; an app password shares one mail path with Proton Mail Bridge.
- **The page.** B, accounts first with a side sheet; C, a list beside the chosen account's detail. Both are in the prototype.

## Consequences

- Sotto holds more secrets than one. `AGENTS.md`'s "One key" names this record, and its permission rule names the switches of decision 7 beside ADR-0029 and ADR-0141.
- A secret now crosses from the desktop to a host. It travels only over the connection the desktop already holds to that host (its tailnet listener carried by Tailscale Serve, or SSH), and a host that is taken over yields every copied account. The switch per account and the default are the user's control over that.
- A limit shared across computers is only as exact as their last contact: a host cut off from the desktop can spend what was left when it last heard, and no more, so the two together can pass the limit by at most that remainder.
- ADR-0141's two rules for a host, that its threads always ask and that it counts its own credits, give way to decision 4 for a copied account. ADR-0141 carries the note.
- Watcher can read from a plugin, so what it reads goes to Watcher's provider as a thread's does. A mail account still asks once before Watcher's first read of it.
- GitHub through Sotto's tools asks before a change while an agent's own shell does not. The page says so rather than implying a protection that is not there.
- An app password is all-or-nothing at Google and at Proton Mail Bridge. Decisions 6 to 8 are the only thing between an agent and the whole mailbox, so they are tested as a boundary, not as a convenience.
- A thread's provider sees whatever a read returns: mail, build logs, project names. The mail card says so; the page says it once for every plugin.
- Vendor icons are drawn from each service's own mark, with the source of each recorded beside it as provider marks record theirs. The trademarks belong to their owners.
- Still to settle on a card when each slice starts: X's monthly limit and whether Sotto sets the automated label; what ElevenLabs is for beside files in a thread's folder, given that nothing in Sotto speaks ([ADR-0068](0068-remove-voice-control-and-thread-management.md)); Higgsfield's limit.
