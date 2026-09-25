# Sotto guide

The [README](../README.md) says what Sotto is and how to install it. This guide covers the rest: every surface in detail, what each request sends, remote hosts, settings and troubleshooting. For provider setup and the coordinator in depth, read [agent control](agent-control.md). The [glossary](../CONTEXT.md) defines the names Sotto gives things.

## Contents

- [Threads](#threads)
- [Tools](#tools)
- [Git, branches and worktrees](#git-branches-and-worktrees)
- [Remote hosts](#remote-hosts)
- [Headless host](#headless-host)
- [Dictation and settings](#dictation-and-settings)
- [Updates](#updates)
- [Install in detail](#install-in-detail)
- [Privacy in detail](#privacy-in-detail)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## Threads

### Providers and models

Threads run in the installed Codex, Claude Code, Grok Build and Devin clients. Connect clients independently in **Settings → Providers** and choose a model for each thread. The model chip opens a two-column menu: the connected providers as a rail of marks down the left, and that provider's models on the right under a search line. The permissions chip beside it lists what a thread may do without asking; on Devin it lists Devin's own modes, each saying what Sotto will still ask you about under it. A model is listed under the fullest name its provider gives it, version and all, and the one the provider recommends stays at the top. **Settings → Agents**, below Hosts, configures Sotto's separate coordinator inline for deep reasoning and thread management. The floating widget retains click-to-dictate and dragging. In a thread composer, open the effort chip to slide between the model’s supported reasoning levels; each level says what it costs. Release to choose, or use the wheel, the arrow keys, Home, End or the digits, and **Default** returns to the model’s own level. A new thread starts on that level unless you choose another; for Grok it is the level Grok marks as its default, not the one set in Grok’s own settings. The level you choose shows at once and the card stays usable while it is saved, so you can keep moving; the provider has the last word, and a change it will not take goes back to the level you were on and says the change could not be confirmed. At the model’s highest level the word, the chip and the composer’s outline take the **Effort color** chosen in **Settings → Appearance** (Ember, Cyberpunk, Rainbow, Aurora, Plasma or Theme accent), and reaching it plays a short wash of that color; reduced motion shows the finished state. Claude’s **Add Ultrathink to prompt** puts a visible instruction in the current draft without changing effort or permissions. Ultracode workflow orchestration is not currently exposed in Sotto.

New threads inherit the native agent and model selected in **Settings → Agents**, including its reported default model when no model is selected. An unavailable selection waits until it connects or you choose another model in **Thread options**. With no native agent selected (Not configured or an API account), Sotto starts with an available native thread provider.

Codex model, effort and permission changes use its native settings update and wait for confirmation. An interrupted change does not disconnect the provider. If Codex cannot confirm it, the affected thread asks you to choose its settings again before sending. Other threads remain available; reconnecting does not replay the settings change.

### The voice coordinator (off for the beta)

The **Agents** room coordinates threads by voice. It collects prompts until you say **“send it,”** supervises only the threads you assign, queues questions one at a time, and yields a thread to manual control when you send directly in the native client. Replies can be spoken: Grok Altair sends reply text to xAI on a separately saved xAI key, Kokoro Heart sends it through OpenRouter on your existing key, and the natural voice runs on this computer after a one-time download. The voice coordinator and memory are switched off for the beta, so the Agents room, the reply voices and the Memory page stay hidden until they are turned back on.

Native clients retain their own subscription sign-in and model catalogs. Wake control requires separately supplied compatible local model/runtime files; their distribution, real microphone acceptance, and macOS live checks remain release gates. Production sign-in, checkout, and billing webhooks are not deployed. Until a membership service is configured, every build, installed or unpackaged, labels access **Private beta** and allows agent actions; that is not a paid entitlement.

### Questions and permissions

Model questions with choices appear above the thread's message bar. Pick an answer or type in **Write my own answer**, then press **Send answer**. The model's suggested option is marked **(recommended)** when it supplies one; nothing is selected for you. Enter adds a line to a custom answer. Escape collapses the question, and reopening it keeps your answer. Prepared choices also survive restarting Sotto. Long forms scroll inside the panel, while your message draft stays separate. In a very short split pane, collapse the question to return to reading the thread. Pending permissions and saved-answer recovery remain reachable by scrolling the pane. Questions without supplied choices keep their text-answer path.

Sotto enables Codex's clarification tool during normal work and asks it to use that tool for questions that need your answer. A question can appear while Codex continues independent work. Only **Send answer** submits your choice. Questions written only as ordinary chat text remain in the conversation.

When Codex asks you to open a link, for example to sign in to an app, the question shows the link with **Continue** and **Decline**. Open the link yourself, then press **Continue**.

### Codex's Computer Use

Codex can see and operate the apps on your computer with its Computer Use, as it does in the Codex app. In Sotto it works when two things are true:

- The thread's permissions are **Full access**. Codex's sandbox stops Computer Use in every other mode. Full access means exactly that: Codex can then run anything and change anything, on the whole computer.
- The Codex desktop app is open. Computer Use talks to a helper the Codex app runs.

Ask for it by name ("use Computer Use to…") or with Codex's `$computer-use` skill. Its calls show in the thread's activity as **Computer Use**. When one fails because either condition is missing, the activity says which, and nothing was changed.

### Sending, steering and screenshots

While a thread is running, **Steer now** beside a queued message sends that message into the current turn when the provider supports steering. The rest of the queue and any newer composer draft stay in place. An unconfirmed message cannot be steered again; use **Check again** to reconcile its delivery.

Paste a screenshot into a thread's prompt, drag it in, or choose **Attach screenshots**. Codex models that accept images and Claude Code models support screenshots; text-only models keep the control unavailable. Send an image on its own or alongside text, with up to eight images, 10 MB per image and 20 MB total. Grok Build currently cannot receive screenshots through its native client.

You can create a thread from the Threads page while another thread has a saved coordinator draft. The draft stays with its original thread, including while the voice coordinator is hidden for the beta.

### History and copying

A thread's messages and retained activity are Sotto's own record, kept in `threads.sqlite` in the app's data folder rather than rebuilt from the provider each time Sotto starts. A thread pane opens on its newest ten turns; press **Show earlier messages** above the oldest one to read further back. A provider session starts when you open or send to a thread, not at connect, and one left idle for thirty minutes is stopped until the next time it is needed. With **Keep local history** off, no message text or activity output is written to disk; turning it off removes the text already written, and what was not kept cannot be recovered. See [ADR-0016](adr/0016-sotto-owned-history-on-an-event-store.md).

Hovering a message or a finished reply shows a copy control at its top corner. One press copies it as Markdown, so code blocks, lists and tables paste intact somewhere else. Right-click the control, or press Shift+F10 with it focused, to copy as plain text instead. A reply still being written has no copy control, and each code block keeps a copy button of its own.

### Working indicators

When Claude Code reports an active monitoring task, a small pixel creature walks above the composer with a magnifying glass and the task name. It appears immediately for a confirmed watch, including a brief one, and leaves when the watch ends, the thread disconnects, or your answer is needed. Ordinary commands and unattended background processes do not trigger it. Reduced motion holds a still inspection pose. Codex, Grok Build and Devin stay hidden until their native events can confirm the same lifecycle.

When Claude Code reports that a workflow, subagent, teammate or remote agent started from a thread is still running, the same creature stands by the readout and sends small agents out along the track, one for each task, up to six. The readout names the first task and says **Working**, or *Working · 3 agents* when there are several; hover it to see them all. It stays after the turn ends, for as long as Claude Code says the work is running, and leaves when the work finishes, you stop the thread, it fails or disconnects, or your answer is needed. A subagent the turn is still waiting on shows the hourglass instead. While it shows, changing the thread's settings and rewinding it wait for the agents to finish, because either would restart Claude Code and end them. A confirmed monitoring task takes the space first. Reduced motion stands the small agents still in a line.

When one command, tool call or subagent has held a thread for twenty seconds or more, the same creature stands there instead with an hourglass, showing what is running and how long it has run. It reads the thread's own activity rather than any one provider's events, so it is not tied to Claude the way the monitoring creature is; it appears on Claude Code, Codex, Grok Build and Devin threads alike. It says only that time is passing: nothing is being watched on your behalf, and nothing is approved. A confirmed monitoring task or running background work takes the space instead, and a pending question or permission clears it, as before. Reduced motion holds a half-run glass.

When a Claude Code turn ends but a command it sent to the background is still running, the hourglass stays: it names the command by the one-line description Claude gave it, says **Waiting** and counts from when the command started, or *Waiting · 2 commands* when there are several. It leaves when Claude Code says the command has finished. While it shows, Sotto keeps the session running and holds settings changes and rewinds, as it does for background agents, because either would stop the command. If agents are running too, the working creature takes the space and counts the commands beside them: *Working · 2 agents · 1 command*.

### Sidebar and Chats

The Threads sidebar keeps each thread’s provider, status and last activity beneath its project. Drag its right edge to resize it; a wider sidebar reveals the branch, model and working copy. Collapse sidebar makes more room for the conversation, and Expand sidebar restores the width you chose. With the divider focused, arrow keys resize it, Home and End choose the limits, and a double-click resets it. Creating a new thread in a settled project returns the folder to the active sidebar with only the new thread; older threads stay in Settled.

The Chats list resizes and collapses the same way, and remembers its own width. Collapsed, each chat shows as its provider's mark. Chats connect to their providers when Sotto starts. If a provider stops, Sotto tries again after five seconds and then after longer waits; after five tries it shows what went wrong and waits for you to press **Connect**. After you press **Disconnect**, they stay off until you press **Connect** or restart Sotto. Claude Code runs one process per chat and per thread; if one stops, only that chat or thread is affected. A reply it was writing says it may be cut short, and Claude Code starts again there when you send a message.

## Tools

A small dot above-left of the Tools icon means agents are working in the selected thread, or that a browser request in the current or pinned working copy is waiting for your answer. Opening Tools keeps the surface you last used. Inside Tools the surfaces (Browser, Terminal, Files, Changes, PR and Agents) sit on a rail at the panel's outer edge; a dot on one means something is live there: a browser task working or waiting, changed files, or agents working. Away from Changes, its dot follows the check Sotto makes of the working copy after each turn, so a change you make yourself in the terminal shows in Changes at once but lights the dot only after the thread's next turn. **Changes** reads like T3 Code's diff panel: pick **Working tree** (everything uncommitted against the last commit, new files included), **Branch changes** (what the branch adds since it left its base; the base is **Automatic** unless you pick another branch, local or remote), **Latest turn** or any **Turn** (one turn's edits, from the snapshots Sotto keeps of each turn; a turn whose snapshot could not be kept says so). Each changed file is a block with its counts that you can collapse; its name opens it in Files, and **Copy path** copies it. The bar above the files expands or collapses them all, switches between stacked and split views, wraps lines, hides whitespace changes and shows a file tree. Ctrl+D (Command+D on a Mac) opens and closes Changes, or Ctrl+Shift+D when your dictation shortcut is Ctrl+D; a terminal keeps its own Ctrl+D. Changes only reads: commit from the Git action, where the commit dialog lets you leave files out. The one exception is **Checkpoints** on its line, which can revert a whole turn's files and conversation after you confirm. To say something about particular lines, click a line (Shift+click takes more) and press **Comment**, or press a line number to comment on that line alone. Write in the box that opens under the lines (**Add a comment…**; Escape cancels) and press **Comment**. The comment waits on the thread's composer as a chip named for its lines, such as `voice.ts L12 to L15` (old numbers marked "(before)" when every line was removed), and under its lines with **Delete comment** (a comment on lines the comparison on screen does not show is listed after the files). Your next prompt carries each comment with its lines, written out after your message, and the chips clear when it is sent; a refused prompt comes back with them written in. From the keyboard, Tab reaches a file's lines and then the Comment button, the arrow keys move, Shift with an arrow or Space picks, Enter opens the comment and Ctrl+Enter (Command+Enter on a Mac) adds it. Comments are kept until you send them or close the window, and are not saved on their own; once sent they are part of your prompt. **Pin**, **Expand tools panel** and **Close tools panel** sit at the rail's foot. Agents has no Pin control because its roster always belongs to the selected thread. The working copy Tools reads is the panel's footer: the project, the branch when it is known, and the kind of folder. After a disconnect or restart, **Last seen working** means current activity has not been confirmed; the clock and dot wait for fresh provider evidence. Finished agents remain in local history independently of the transcript's activity limit. **Keep local history** controls whether this roster and its task text are saved. Turning it off erases saved tasks and results while unfinished agents keep their status and generic task labels. If you turn it back on, erased assignments stay text-free, including later results; fresh assignments are saved again.

Open **Tools → Agents** in a thread to see its reported subagents. Agents always follows the selected thread, even when the other tools are pinned to another working copy. Each row shows the task, the model it ran on, status and elapsed time when known; a Claude Code workflow row lists its agents' models. Open a row for its task and result, including earlier assignments when an agent is reused. Children appear under their reported parent. **Load earlier agents** reads older entries without loading the whole history at once.

### Browser

Codex, Claude Code and Grok Build can use the browser in **Tools** to inspect and check a page. A corner thumbnail shows the active task; click it to open that same page without changing your conversation. **Pause** stops further browser actions, while dismissing the thumbnail leaves the work running. Open, navigation, click and typing requests wait for your one-time answer. On a request to open a page, **Allow this thread to open pages** also lets that thread open and go to pages without asking until you press **Stop** in Tools > Browser or Sotto closes; clicks and typing still ask every time. The corner thumbnail shows only the task of the focused thread or the thread Tools is pinned to, and **Show browser previews** in Settings turns it off without stopping the work; a waiting request still puts a dot on the Tools icon of the pane showing its thread. Pages you open yourself must be shared before an agent can observe them.

Select an element or region, add a comment, and attach it to the thread's editable draft. Finished tasks retain observed steps, screenshots and unchecked cases for the app session. Image attachments depend on the provider's capabilities. Devin's pinned native client does not support the Sotto browser connection, so its browser is available for manual use and draft feedback only. See [browser tasks](agent-control.md#browser-tasks-in-tools) for details.

## Git, branches and worktrees

New threads use the **Project folder** by default, including its uncommitted edits. Threads in that folder share files and branch. **Thread options** in New thread holds the optional name, model, reasoning and permissions; the working copy is chosen under the composer once the thread is open. There, for a Git repository, the **branch toolbar** shows **Run on** (the machine the thread runs on), **Workspace** (**Current checkout**, **New worktree** for independent parallel work, or **Previous worktree** to reuse a worktree another thread of the project has), the branch's pull request, and the **branch picker**. Workspace locks after the first message. The picker searches the repository's branches and switches the folder to the one you pick, creates a tracking branch for a remote one, offers **Create new ref** for a name that does not exist, and for a new worktree records the branch it starts from with a **Start from origin** switch that fetches that branch on first send. When origin does not have that branch, or the project has no origin, the worktree starts from the local branch instead and a notice above the composer says so; only a fetch that fails for another reason, the connection or your credentials, stops setup. Its label reads **Select ref** for a detached HEAD. Picking a branch that another thread's worktree has checked out points a draft at that worktree instead of checking it out twice, and right-click copies a branch name. Git's refusal to switch is shown under the row in Git's words. Uncommitted project edits stay in the project folder. Settings under Application sets the global default; expand **Project defaults** there to override it for a project. Existing threads keep their folders and unfinished work. The **Git action** at the end of the pane header says what the folder needs next and does it from one press: **Commit**, **Commit & push** or **Commit, push & PR** for a folder with changes, **Push** or **Push & create PR**, **Pull** when the branch is behind, **Sync ref** when it is both ahead and behind, **Create PR** or **View PR**, **Publish repository** for a repository without a remote, and **Initialize Git** for a folder without one; its chevron menu holds Commit, Push, Create PR or View PR, and Publish repository for a repository without a remote. A commit opens **Commit changes** first, where you can leave files out, type a message or leave it for the thread's provider to write, and commit on a new branch; a push or pull request from the default branch asks first. The action's progress and result show above the composer. The pull request badge on the branch toolbar opens **Pull request** in Tools (its rail tile reads PR): the branch's pull request, or one linked to the thread, as a merge checklist. Five lines say what stands between it and its base: **Checks passing**, **Review approved**, **Up to date** with the base, **No conflicts** and **Ready for review**. Each is done or carries the one press that fixes it: **Open check** for a failing check and **Open review** for a request for changes (both open GitHub; re-running a check is done there), **Update branch** when the branch is behind, **Ready for review** for a draft. A repository that asks for no review, or a branch with no checks, says so on that line. **Merge** is enabled only when every line is done, in the method beside it (Merge commit, Squash or Rebase), which starts on the **Default merge method** in Settings → Git; until then **Merge when ready** turns on GitHub's auto-merge where the repository allows it. The description and **Linked pull requests** fold below. The **···** menu has Ready for review or Convert to draft, Update with rebase, Merge when ready, Disable auto-merge, Copy link, Link pull request, Unlink from thread, and Close or Reopen pull request; **Open on GitHub** and **Refresh** sit beside it. Merging, turning on auto-merge, closing and Update with rebase ask first; Update with rebase rewrites the branch on GitHub, so a local copy of it no longer matches until you pull or check it out again. With no pull request yet, the surface offers **Create PR**, the Git action's own, and **Link pull request**, which adds one by URL or `#42`. Typing a pull request URL or `#42` into the branch picker offers **Checkout pull request**: **Local** checks it out in the thread's folder, and **Worktree** gives a thread that has not started a worktree of its own on the pull request's branch. It is GitHub only, through `gh` and your own sign-in, and a thread on a paired host reads and acts on its pull request on that host.

The branch label follows the actual checkout. A shared project folder that changes branches can show a dismissible notice while you draft; sending continues on the current branch. **Restore branch** switches back by your choice, asking first about uncommitted changes. A branch you pick in the branch picker is your own switch, so it shows no notice; the notice is for a checkout moved some other way, by the agent, a terminal or another thread. Worktree-backed threads follow their branch without that notice.

A worktree is a full checkout, and an agent that installs dependencies in it can leave a gigabyte or more behind. You can give the folder back: **Remove worktree** in the thread's working-copy control removes the folder and keeps its branch, and settling a worktree-backed thread asks whether to remove its worktree too. Sending to the thread again puts the folder back on that branch. A folder with uncommitted changes is removed only after you confirm that they are lost. Settings under Application also offers rules that remove a clean worktree on their own: after it has been idle for a chosen number of days, when its thread is settled, when its commits are all in the repository's default branch, or when its pull request is merged. Every rule is off unless you turn it on; none of them touches uncommitted work or a folder holding anything but installed dependencies in its ignored files.

The rest of the Git choices are in Settings → Git, each in T3 Code's terms and grouped under the moment it acts, and each description says what Sotto will do with the value shown. **Automatically pull** (off) pulls a thread's folder when it is on the default branch, has no changes and is only behind its remote, each time Sotto checks the remote; the pull is fast-forward only, a folder a thread is working or waiting in is left for the next check, and the pull shows only as the branch no longer being behind. **Diff layout** (Stacked or Split), **Hide whitespace changes** (on) and **Default diff file state** (Expanded or Collapsed, Collapsed to start) are where Changes starts. A choice made in Changes holds until one of these settings changes or Sotto restarts. **Default merge method** (**Last selected**, **Merge**, **Squash and merge** or **Rebase and merge**) is the method the merge in the pull request checklist starts on; under Last selected, a method picked beside that Merge is the one it starts on next time. **Auto-settle merged threads** (off) settles a thread at rest once the pull request of the branch it last sent on is merged, checked once an hour; a thread you restore stays restored while Sotto runs, and settling removes no folder unless a worktree rule says so. **Proactive panels** (off) opens Changes on its own when a turn leaves its folder with at least 3 more changed files or 50 more changed lines, when the Tools panel is closed, without moving the cursor from where you were typing; a large turn in a pane you are not in waits until you go to its thread. It counts the folder's changes before and after the turn, so edits you make by hand during the turn count too, and it counts only while the Threads page is open. **Commit and pull request style** chooses how generated commit messages and pull request text are written: **Repository conventions** (the repository's recent commits and its `AGENTS.md`), **Conventional Commits**, or **Custom instructions** in your own words. Conventional Commits and Custom instructions take precedence over the repository's own style, though its recent commits and `AGENTS.md` are still sent. An example under it shows a commit subject and pull request title in the chosen style; with Custom instructions it shows the subject your instructions start from, because Settings asks no model what it would write. **Follow pull request templates** (on) has the thread's own model follow the repository's pull request template when a Git action drafts a pull request: the first template file in GitHub's usual places, or the only one in a `PULL_REQUEST_TEMPLATE` folder. The **Git fetch interval** is there too, under In the background.

What the Git action and generated names send is in [Privacy in detail](#thread-titles-branch-names-and-git).

## Remote hosts

*Development feature.*

In **Settings > Hosts**, press **Add host** to add any machine you reach over SSH and have installed the host on. Type an SSH host or alias; Sotto suggests the aliases in your SSH configuration (following `Include`) and the hosts in your known hosts, read on this computer and sent nowhere. Username and Port are optional and override your SSH configuration; the host installation and data folders are under **Folders on the host** and start at `~/.local/share/sotto-host` and `~/.sotto`. Pressing **Add host** connects from inside the dialog: it starts or discovers the installed host, forwards its loopback listener and pairs this computer itself over that connection, with no code typed. The host is saved, named after what you typed, only once it answers. If it cannot be reached, the dialog says what happened and that nothing was saved; close it and nothing is kept. Add as many hosts as you like. The desktop uses your SSH configuration (aliases, users, ports and identity files) but turns connection sharing, and any `RemoteCommand` or `RequestTTY` it sets, off for its own connections. On Windows it uses Windows' own OpenSSH. Sotto needs OpenSSH 8.4 or later on this computer, and says so when it finds an older one.

Sotto asks before trusting a new host key, and for a password or key passphrase when SSH needs one: in the Add host dialog while you add a host, and over whichever page is open when a saved host connects on its own, such as when Sotto starts. **Switch it off** there stops connecting to that host until you switch it on. You answer once per connect, although a connection runs several SSH commands. What you type goes only to ssh on this computer, is kept in memory until the connection closes, and is never written down or logged.

Each saved host's row says where it is and how it is ("SSH forge · Connected", "Reconnecting…", "Switched off", or "Needs attention" with a sentence saying what to do), and has an **On/Off** switch. A host that is on stays connected: Sotto connects to it when it starts, in the background, and a dropped connection reconnects on its own, after 3, 4 and 8 seconds and then every 16 seconds. When only you can fix what went wrong, such as a refused sign-in, a changed host key, or a missing Node or host installation, Sotto stops retrying and says what to do; **Connect again** tries once you have. Switching a host off disconnects it and keeps it off at launch; its row and pairing stay.

A host Sotto started keeps running until you stop it. Switching it off, quitting Sotto and a dropped connection all leave it working, so another paired client can keep using it and running turns finish. The row's **More** menu has **Stop host**, which stops a host Sotto started and switches it off; **Rename**; **Edit connection**, which changes the route and connects again if the host is on, and shows this computer's client ID on that host; and **Forget**, which revokes this computer's access, stops a host Sotto started, and removes the saved connection. A host you started yourself is never stopped by Sotto. You can Forget a host you can no longer reach; this computer's access on it then stays until you revoke it there with `--revoke-client`.

Because a host outlives updates to this computer, the two can run different versions of Sotto. That is fine while they speak the same host protocol ([docs/host-protocol.md](host-protocol.md)). When they do not, the host's row says which side to bring up to date. An older host: "This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, press Stop host, then connect again." The version it names is this computer's, and the host archive goes first because connecting starts whatever is installed there; after Stop host, switch the host on to connect again. **Stop host** stays on the row for a host Sotto started; a host you started yourself you stop on that machine, and the sentence says so. A newer host: "This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again."

A client that cannot pair itself over SSH enters a code shown on the host instead. On the host, from the extracted host folder, request a fresh code:

```sh
node host/index.js --data /path/to/sotto-data --pairing-code
```

The code expires after five minutes. Pairing admits this device; permission answers need a separate policy grant from the host's user. Use the client ID the client shows, or the one **Edit connection** shows for a desktop connection, to grant, deny or revoke access explicitly:

```sh
node host/index.js --data /path/to/sotto-data --allow-answers CLIENT_UUID
node host/index.js --data /path/to/sotto-data --deny-answers CLIENT_UUID
node host/index.js --data /path/to/sotto-data --revoke-client CLIENT_UUID
```

Threads from connected hosts share one sidebar. When a remote host is connected, each project shows a small badge with its host's name, this computer included, and each thread its host. With more than one host listed, **New thread** starts with a row of host buttons: choosing one lists that host's projects, and a folder you add becomes a project on the host you chose. A thread's host is fixed once it exists, and its composer says where it runs: **Run on** on the branch toolbar for a Git repository, and "Runs on forge" beside the model for any other folder. Threads from different hosts keep their own identities, drafts and actions. Turning **Run the local host** off takes effect after **Restart Sotto**, leaves saved data intact and keeps dictation available. Folder and terminal tools and Changes, for a remote thread, explain that they run on the host machine. The branch toolbar, the Git action and the Pull request surface work the same as for a local thread, run by the thread's host. Dictation and paste remain on the desktop computer. Provider credentials, account setup and host administration stay on the host.

After an interrupted command, reconnect and check its result before choosing to send again; Sotto never automatically repeats it.

An iPhone client is planned in its own pull request ([#225](https://github.com/millZach/Sotto/pull/225)) and is not part of this build. Its setup, including the private address it reaches the host through, arrives with it.

## Headless host

*Development feature.*

The host can run under Node 24 on Windows or Linux without Electron or a display. It owns its providers, worktrees and saved history. Build from a checkout with `npm ci` and `npm run build:host`, then run:

```sh
# From a checkout, after npm run build:host
node out/host/index.js --data /path/to/sotto-data --key-file /path/to/private/sotto-key
```

From an extracted host archive the entry is `host/index.js` instead of `out/host/index.js`; the commands below use that form.

`SOTTO_HOST_DATA` and `SOTTO_HOST_KEY_FILE` provide the same options. The data folder must be explicit. Use a dedicated host folder; desktop credentials use the operating system store and cannot be opened with a host key file.

The key file contains a user-supplied secret of at least 16 characters. Keep it outside the data folder, restrict access to your account, and back it up separately. Sotto encrypts credentials with scrypt and authenticated AES-256-GCM using Node builtins. It never saves the key beside them. A missing or wrong key, or a damaged credential file, stops startup without replacing that file. You may omit the key file while no credentials have been saved; saving a credential then requires restarting with one. Native provider sign-ins remain with their installed clients.

Settings are read from the data folder at startup. That includes the worktree cleanup rules: the host reclaims its own worktrees under them the way the desktop does, and every rule is off unless that folder's settings turn it on. No paired client can set them yet: to turn one on, stop the host, edit the `worktreeCleanup` object in the data folder's `settings.json` (`onSettle`, `unchanged` and `merged` are `true` or `false`; `afterDays` is `null` or 7, 14, 30 or 90 days without activity), and start it again. The merged rule asks GitHub through `gh` and its sign-in on the host machine. The host's own Git settings work the same way: `gitAutoPull` and `autoSettleMergedThreads` (`true` or `false`, both off) are read at startup, and `gitWritingStyle` (`"repository"`, `"conventional"` or `"custom"`), `gitWritingInstructions` and `followPullRequestTemplates` are read for each commit message and pull request the host writes; the desktop's own Settings do not reach a remote host. The headless entry exposes `startHeadlessHost({ dataDirectory, keyFile })` in-process; its `service` is the same `HostService` that the desktop uses. `close()` drains provider and reasoning processes, a worktree cleanup in progress, and durable writes. The command-line host handles SIGINT and SIGTERM and opens an authenticated loopback listener. Add `--port 4319` to keep a fixed port, or omit it to choose an available port. Readiness output names the host and port, and its health check names its Sotto version and the host features it offers. The private `host-listener.json` file includes a local administration credential; do not share it. An embedded host opens a listener only when given a `port` option.

Run `npm run test:host` for the plain-Node lifecycle and `npm run test:socket` for authenticated child-process client journeys. `npm run package:host` creates an archive and checksum with the platform in its filename, then extracts and smoke-tests it. See [host packaging](release/releasing.md). Deployment to a real Linux machine still needs a live check.

A normal stop removes the host's listener descriptor and lock. After a crash or a reboot, the next start finds the old `host-listener.lock`, checks that the process it names is gone or ran before the machine last restarted, and takes the folder over; nothing needs cleaning by hand, and when several hosts start at once, only one takes it. If that process is still running, startup refuses and names it, and a lock file it cannot read is left for you to look at. Only one host may use a data folder at a time. The SSH account needs Node 24. Sotto looks for it on the account's path, then through its login shell, then where nvm, fnm, mise, asdf, Volta and Homebrew keep it, and says which Node it found if none will do. When Sotto starts the host over SSH it passes no key file, so a data folder that already holds saved credentials needs `SOTTO_HOST_KEY_FILE` set for that account.

A remote host keeps its own OpenRouter key, in its encrypted credential file, and never receives the desktop's: a paired client cannot send a credential. Without a key there, OpenRouter-hosted reasoning on that host stays off. Thread titles, branch names and Git drafts need no key on a host: the provider running each thread writes them (ADR-0026).

## Dictation and settings

Press the global shortcut once to start and again to stop and transcribe. The default is `Ctrl+Shift+Space` on Windows and `⌃⇧Space` (the literal Control key) on macOS. `Escape` cancels an active session. The floating widget also starts dictation with a click and can be dragged anywhere.

Settings:

- Dictation: microphone, global shortcut, recording limit, local sound cues, and streaming transcription so long dictations finish almost immediately after you stop
- Transcription: MAI-Transcribe-2 through OpenRouter (the only model), your OpenRouter API key with a verify button, language, and conservative whitespace formatting
- Cleanup: optional AI cleanup with quality tiers and the personal dictionary that also feeds transcription spelling hints; and the switches for generated thread titles, commit messages and pull request text
- Output: mandatory clipboard safety copy, optional automatic paste, paste delay, and success-message duration
- Appearance: the color scheme (Light, Dark, or match the system), then one theme for light mode and one for dark, chosen in two columns. Sotto ships six themes of its own: Sotto, Hush, Linen, Nocturne, Tropic and Citrine. Sotto is the default, with an almost-black dark room and the app icon's teal (a deeper teal in light mode, so text and links stay readable). You can create a theme, import a T3 Code or VS Code theme file, or install one from Open VSX. Below the themes: the effort color, contrast and glass.
- Updates: the version you are running and, on Windows, an automatic GitHub release check that is on by default and can be turned off, plus a manual check
- Application and privacy: launch at login, start minimized, local history, retention, clear history, and reset settings; for threads, the working-copy default and the worktree cleanup rules
- Git: every Git setting, grouped under when it acts: the Commit and pull request style with its example; Follow pull request templates, Default merge method and Auto-settle merged threads; the diff defaults for Changes and Proactive panels; the Git fetch interval and Automatically pull

Automatic paste is best effort. Windows blocks synthetic input into elevated applications, password fields, protected desktops, and some custom editors. macOS blocks it in secure input fields and until both the Automation and Accessibility grants exist. When paste is rejected, Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard. If a Windows target app is running as administrator, either paste manually or run both apps at the same integrity level.

## Updates

Automatic update checks are on by default. Shortly after launch and then every few minutes, the installed Windows app asks the GitHub releases page whether a newer version exists, which means GitHub sees an ordinary web request from your computer: IP address, time, and the version you are running. No audio, transcripts, settings, or identifiers are sent. When a release is found, the update control at the end of the sidebar foot offers it: one press downloads it, the next press asks before restarting into the installer, and nothing is installed behind your back when you quit. The whole check can be turned off under Settings → Updates, and "Check for Updates…" in the tray menu runs one on demand. The macOS disk image carries no update feed, so on a Mac, download each new version from the [releases page](https://github.com/millZach/Sotto-releases/releases/latest).

Client update checks are on by default. When a provider connects, and at most once an hour for each one, Sotto asks the npm registry (registry.npmjs.org) which version that client publishes: Claude Code, Codex and Grok Build. The request carries a package name and nothing else, and npm sees an ordinary web request from your computer. Devin is never asked about, because it ships inside the Devin app and updates itself. When a client is behind, a card in the bottom-right corner names the installed and published versions, and one press installs it the way that client installs: `npm install -g` for a package npm owns, or the client's own updater when npm does not own it. The provider disconnects first, and so do your personal chats on that provider, because a running client cannot be replaced and a turn in flight would be lost. Both reconnect when the update finishes, and nothing reconnects while it runs. A provider with a thread working says so and waits for you to say "Update anyway". If the installer finishes but the client still reports its old version, because another app is holding it open, Sotto says that rather than calling it updated. The card then shows one line with Try again, and why under Details. An install Sotto does not recognise shows the command to run instead of a button. Turn the whole check off with "Check for client updates" in Settings → Providers, which also carries each client's installed version and a Check again press.

## Install in detail

### Windows

Run the `Sotto Setup <version>.exe` installer and choose the per-user installation folder. The desktop shortcut is optional and unchecked by default; the installer always creates a Start Menu shortcut. Uninstalling removes either shortcut but preserves settings and history by default so an accidental uninstall does not silently destroy local data.

Locally built artifacts are not code-signed because no Windows signing certificate is stored in this repository. Windows may therefore show an **Unknown publisher** or SmartScreen prompt. A public release should be Authenticode-signed by its distributor without changing application behavior.

### macOS

1. **Copy the app to Applications.** Open `Sotto-<version>-arm64.dmg` and drag **Sotto** onto the **Applications** shortcut in the same window, then eject the disk image and launch Sotto from Applications. Do not run Sotto from the mounted image: macOS App Translocation launches downloaded apps from a randomized read-only path, which changes the app location on every launch and makes permission grants and settings unreliable.

2. **Allow the unsigned build to open.** Sotto is ad-hoc signed but has no Apple Developer signature, so the first launch is refused with a message such as *"Sotto" is damaged and can't be opened* or *macOS cannot verify that this app is free from malware*. Open **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the message about Sotto, then confirm and launch Sotto again. Use this path first: macOS 15 and newer no longer offer the old Control-click → Open bypass for this case. As an alternative, clear the quarantine flag in Terminal and launch normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Sotto.app
   ```

3. **Grant the permissions Sotto asks for.** The first dictation asks for microphone access. The first automatic paste asks for Automation ("Sotto wants to control System Events") and needs Sotto enabled in **System Settings → Privacy & Security → Accessibility** as well. Denying or missing either grant never loses a transcript: Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard, and automatic paste starts working as soon as both grants are in place.

4. **Expect the permission prompts again after every update.** macOS keys these grants to the app's code signature, and an ad-hoc signed build gets a fresh identity on every rebuild. After installing a new version, macOS treats Sotto as a new app and asks for microphone, Automation, and Accessibility again; a stale entry may need to be removed from the list before the new one takes effect. This stops once Sotto ships Developer ID-signed builds.

### After install

First-run setup explains what leaves the computer, tests microphone access, takes your OpenRouter API key (you can add it later in Settings), and shows the active shortcut and safe paste-test field. The default global shortcut is `Ctrl+Shift+Space` on Windows and `⌃⇧Space` (the literal Control key) on macOS. Press it once to start and again to stop and transcribe. `Escape` cancels an active session.

Sotto closes to the Windows notification area or the macOS menu bar. Use that menu to show the window, start or stop dictation, toggle automatic paste, or quit completely. On macOS the Dock icon appears only while the Sotto window is open; the menu-bar icon is always there.

## Privacy in detail

The README's [Privacy and cost](../README.md#privacy-and-cost) section names every host Sotto connects to. This section says exactly what each one receives.

### Dictation, cleanup and reasoning

Dictation audio is uploaded to OpenRouter and transcribed by Microsoft MAI-Transcribe-2 only while you dictate. Your personal dictionary words travel with each request as spelling hints, and the text comes back. Nothing is transcribed on this computer, so Sotto needs your OpenRouter key and a network connection to dictate; when either is missing, Sotto says so instead of transcribing elsewhere. OpenRouter charges your balance at the model's published audio rate (about $0.10 per hour of audio at the time of writing). Read [OpenRouter's privacy policy](https://openrouter.ai/privacy) for what it and its providers retain.

Optional AI cleanup is off by default. When you enable it, the finished transcript (never audio) is sent to OpenRouter with the same key for punctuation and self-correction cleanup. If the network is slow or offline, Sotto delivers the raw transcript instead. Optional agent control also sends the prompts you submit to the connected harness and, when configured, sends assignment text and relevant thread context to your selected reasoning provider: `openrouter.ai` for an OpenRouter account, `api.openai.com` for an OpenAI one. Agent replies default to Grok Altair, which sends reply text to xAI using a separately saved xAI API key. Kokoro Heart is a lower-cost choice that sends reply text through OpenRouter using the existing OpenRouter key. Voice previews incur the same provider usage charges; neither option silently falls back to another provider. The optional natural voice is generated on this computer after a one-time voice download. Provider usage is billed separately from Sotto access. Credentials are encrypted using the operating system credential store and are not returned to the UI.

Sotto has no analytics or crash upload. Dictation audio is never persisted. Transcript history is local, optional, bounded, searchable, and clearable. Two small diagnostic files in Sotto's data folder help explain a lost dictation: `polish-diagnostics.jsonl` records word counts around AI cleanup, and `transcription-diagnostics.jsonl` records why a transcription request failed (reason, HTTP status, attempts, clip length and time taken). They hold no words, audio or keys, each starts over past 256 KB with one older copy kept, and neither leaves this computer.

### Thread titles, branch names and Git

Thread titles, new worktree branch names, commit message drafts and pull request drafts are written by the thread's own provider: Claude Code, Codex or Grok Build, on your account and the thread's model, in a separate one-off request that never enters the thread's own conversation. None of these four goes to OpenRouter or anywhere the thread was not already going. With Generated thread titles and Keep local history on, the provider is sent the thread's first message and first reply, each capped at 2,000 characters, to name the thread, and a new worktree's first prompt alone, capped at 2,000 characters, to name its temporary branch; no branch request is made for a shared project folder or an existing worktree. The Git action that commits from one press sends, when the commit dialog's message is left empty, the staged diff, the names of the staged files, the repository's last twenty commit subjects and its `AGENTS.md`, so the message follows the house style, and the pull request text is written from the branch's commit subjects, its file list, a capped diff and the repository's own pull request template where Sotto finds one; with **Follow pull request templates** off the template is not read or sent. With the **Commit and pull request style** set to **Custom instructions**, what you wrote there is sent with each of those two requests as well. When the provider writes nothing, the action commits under the subject "Update project files" rather than waiting. The action stages what it commits itself, everything or the files you chose, so anything staged by hand beforehand is staged again from the working tree; and it fetches first, under the same 15-second rule as a refresh, unless the Git fetch interval is Off. A push goes to the remote `branch.<name>.pushRemote` or `remote.pushDefault` names, else to the branch's upstream when it tracks a branch of the same name, else to `origin`, or the first remote when there is no origin, under the branch's own name. A pull comes from the upstream. Both use Git's existing authentication; after a push from a branch other than the default one, Sotto asks GitHub through `gh` whether it already has a pull request, and Create PR and Publish repository go to GitHub through `gh` on your own sign-in. These drafting requests count against the provider's usage limits like any other, at the lowest effort the thread's model offers. Devin threads keep their placeholder name and commit under the stand-in subject when the message is left empty, because Devin cannot answer once without keeping a session of its own. A failed or disconnected provider leaves the placeholder name, the temporary branch or the stand-in subject, and the turn continues. Turn off Generated thread titles to stop both kinds of automatic naming. See [ADR-0026](adr/0026-short-writing-runs-on-the-threads-own-provider.md). Turning on **Start from origin** in the branch picker for a new worktree fetches that branch from the project's configured Git origin before setup; Git contacts that remote using its existing authentication. The worktree cleanup rule "when its pull request is merged" asks GitHub once an hour, through the `gh` command and its own sign-in, whether each candidate branch's pull request is merged; the other rules read only the local repository and contact nothing. All of them are off until you turn one on. **Auto-settle merged threads**, also off until you turn it on, asks the same question on the same hourly schedule for the branch each thread last sent on, and asks once per branch when both want the answer. **Automatically pull**, off until you turn it on, runs `git pull --ff-only` against the branch's own upstream over Git's existing authentication, only for a folder on the default branch with no changes that is behind, and only when Sotto has just read the remote as described below. While the Sotto window is in front, Sotto also fetches each open thread's project from its Git origin at the **Git fetch interval** in Settings (every 30 seconds unless you change it), and when you refresh a thread's working copy, no more than once every 15 seconds, so the thread's branch knows whether it is ahead of or behind the remote; the fetch uses Git's existing authentication, never answers a prompt, and sends nothing but the fetch itself. With the interval Off, Sotto fetches nothing at all, not on a refresh and not before a Git action, and ahead and behind compare with the remote as it was last fetched. On the same schedule, and whenever you refresh a thread's working copy, Sotto asks GitHub through `gh` on your own sign-in whether the branch has a pull request, for branches that have been pushed. The Pull request surface in Tools asks GitHub through the same `gh` only when you open it, press Refresh, or press one of its actions: it reads the pull request's description, checks, review decision and who approved it or asked for changes, mergeability, the merge methods the repository allows and how far the branch is behind its base, and it merges, marks ready or draft, closes, reopens, updates the branch or turns auto-merge on or off only on your press, the merge, auto-merge, closing and a rebase update after a confirmation. Link pull request and Checkout pull request read the pull request you name through `gh` too (a checkout takes only a pull request of the project's own origin repository), and a Worktree checkout fetches its branch from the project's origin with Git's existing authentication. See [ADR-0027](adr/0027-git-the-way-t3-code-does-it.md).

### Browser

The Tools browser contacts the HTTP(S) pages you open, including local development servers, and the subresources those pages request. Browser agents use Sotto's own pages through thread-scoped tools; providers that require MCP connect to an authenticated endpoint on `127.0.0.1` on this computer. When you authorize browser work or send selected page context, its screenshots and relevant page data go to that thread's provider under the provider's data policy. Sotto keeps browser-task evidence and page grants in memory, never in operational logs. Explicitly attached/sent material follows the existing draft and history controls. See [the browser decision](adr/0020-sotto-owned-browser-tasks.md).

### Remote hosts

When you connect a remote host, Sotto sends your thread reads, prompts and explicit request answers to the host you configured. The host socket listens only on its own loopback address. The desktop reaches it through your SSH connection. Pairing identifies each client and can be revoked. Provider credentials stay on the host, and pairing does not approve permission requests. No public listener, relay account, analytics or new provider service is enabled by connecting a client.

### Themes and the natural voice

Searching for or installing a theme from Open VSX contacts `open-vsx.org`, and its downloads come from `openvsxorg.blob.core.windows.net` or `openvsx.eclipsecontent.org`. Importing a T3 Code or VS Code theme file reads only that file. The natural voice (Supertonic, an ONNX model) is downloaded once from `huggingface.co` and its download servers, checked against a locked list of files and hashes, and then runs on this computer.

### Devin

Devin CLI uses your native Devin account and its separate billing, data policies, local session storage, and usage analytics. Keep local history controls only Sotto's copy; it does not erase or disable Devin's records. Review your native account's training and retention controls. The tested native account route contacts server.codeium.com for the service and o4507463137361920.ingest.us.sentry.io for provider telemetry. Devin starts disabled. Its tested Windows baseline is CLI 3000.10.31; Apple silicon verification is still pending. See the [Devin data-policy decision](adr/0017-devin-native-provider-data-policies.md).

## Development

```powershell
npm ci
npm run runtime:verify
npm run dev
```

The ONNX WASM runtime that powers the optional natural voice is represented by a hash-locked manifest. If a clean source checkout does not contain its large files, prepare them once with network access:

```powershell
npm run runtime:prepare
npm run runtime:verify
```

Transcription itself needs no local assets: run the app, paste an OpenRouter key in Settings, and dictate.

The same commands run in Terminal on macOS.

### Tests

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run runtime:verify
```

Unit and integration tests cover settings recovery, history privacy, audio math and lifecycle, the OpenRouter transcription request and its failure reasons, runtime integrity, IPC validation, hotkeys, clipboard-before-paste output, startup, tray, window security, transcription orchestration, and widget synchronization. Electron end-to-end tests use an admitted non-packaged boundary with deterministic in-memory microphone, shortcut, clipboard, paste, startup, tray, and transcription adapters. They cover onboarding, registered-hotkey dictation, in-app paste, history on/off, theme and settings reload, hotkey conflict, microphone denial recovery, silence, paste fallback, hide-to-tray, single-instance behavior, and transcription failure. Widget visual tests verify ten 420x92 light/dark state images and transparent corners.

The deterministic boundary is rejected in packaged builds and accepts calls only from the trusted main renderer. It never logs transcript text or PCM.

Every push to `main` and every pull request against it runs typecheck, lint, `vitest run` and the third-party notices check on a Windows runner (`.github/workflows/ci.yml`). Desktop end-to-end tests and live provider suites stay local. A separate Linux job checks the host archive and socket contract. See the [continuous integration guide](ci.md) for what each step does and how to read a failed check.

### Windows packages

```powershell
npm run package:dir
npm run package:win
```

Artifacts are written to:

- `release/win-unpacked/Sotto.exe` — unpacked x64 application
- `release/Sotto Setup <version>.exe` — assisted, per-user x64 NSIS installer

Brand assets (`build/icon.png`, `build/icon.ico`, `build/installer-sidebar.bmp`) are generated from the SVG masters in `build/` with `node scripts/generate-brand-assets.mjs`.

The packaged `resources` directory contains `runtime/`, `README.md`, and `THIRD_PARTY_NOTICES.md`. Each packaging command automatically verifies the source runtime before packaging and verifies the packaged runtime, notices, bridge and worklet afterward.

### macOS packages

```bash
npm run package:dir:mac
npm run package:mac
```

Artifacts are written to:

- `release/mac-arm64/Sotto.app` — unpacked arm64 application bundle
- `release/Sotto-<version>-arm64.dmg` — arm64 disk image with an Applications shortcut

Both commands verify the source runtime before packaging and the packaged runtime, notices, bridge and worklet afterward, exactly like the Windows commands. After `npm install`, a fresh clone must run `npm run runtime:prepare` once to copy the runtime files from the installed ONNX Runtime package; this preparation step needs no network access.

The macOS icon is derived automatically from `build/icon.png` at packaging time; no `.icns` file is committed. The menu-bar template images (`resources/tray/sottoTemplate.png` and its `@2x` companion) come from the same `node scripts/generate-brand-assets.mjs` run as the Windows brand assets.

Builds are ad-hoc signed and not notarized, so anyone installing the disk image needs the macOS install steps above. Widget design captures (`npm run design:capture`) stay Windows-only; the committed reference images are captured on Windows.

## Troubleshooting

### Either platform

- **Shortcut conflict:** Choose another accelerator in Settings. Sotto keeps the last working shortcut if registration fails.
- **No speech detected:** Move closer to the microphone and confirm the level meter responds. Silence does not replace the clipboard or create history.
- **"Add your OpenRouter API key":** Transcription needs a key. Paste one under Settings → Transcription and press **Verify key**.
- **"OpenRouter rejected the API key":** The key is wrong or revoked. Check it at [openrouter.ai/keys](https://openrouter.ai/keys) and verify it again in Settings.
- **"Sotto could not reach OpenRouter":** Check the internet connection and any proxy or firewall, then dictate again. Nothing was lost except that recording.
- **"Out of credit":** OpenRouter has no credit left for the key, or the key reached its own limit. Add credit or raise the limit at [openrouter.ai](https://openrouter.ai/settings/credits), then dictate again.
- **"Too many requests":** OpenRouter is rate limiting the key. Wait a minute, then dictate again.
- **"OpenRouter error" or "Couldn't transcribe":** OpenRouter's transcription service failed, or its answer could not be read. Dictate again in a moment. If it keeps happening, `transcription-diagnostics.jsonl` in the app's data folder records each failure's reason and HTTP status, without any of your words.
- **AI cleanup not applied:** Check that AI cleanup is enabled and that the computer is online. When cleanup fails or times out, Sotto delivers the raw transcript instead of failing the dictation.
- **Terminal view could not load:** Press **Reload window** to try again. Terminals keep running and retain their output. Sotto saves thread drafts first and keeps the window open if any thread draft or question answer is not saved. Save those drafts, then try again.
- **Window disappeared:** Sotto is probably hidden in the Windows notification area or the macOS menu bar. Open it from that icon or start Sotto again; the existing instance will be shown.
- **A thread never asks:** The provider says a request only you can answer was declined without reaching you. Its client is not routing those requests, so it answers them itself and the thread keeps working. Nothing in the thread is lost. Answer in that client meanwhile, and check **Settings → Providers** for a client update and Sotto for its own.

### Windows

- **Microphone denied:** Open Windows Settings → Privacy & security → Microphone, enable microphone access and desktop-app access, then retry.
- **No microphone found:** Connect or enable an input in Windows Settings → System → Sound, then select it in Sotto Settings.
- **Paste did not occur:** Paste manually with `Ctrl+V`; the transcript is already in the clipboard. Elevated and protected targets commonly reject automation.

### macOS

- **"Sotto is damaged and can't be opened":** This is Gatekeeper refusing an unsigned download, not a corrupted file. Use **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Sotto.app`, then launch Sotto again.
- **Microphone denied:** Open System Settings → Privacy & Security → Microphone, allow Sotto, then retry.
- **Paste does nothing:** Sotto needs both System Settings → Privacy & Security → **Automation** (Sotto allowed to control System Events) and → **Accessibility**. Enable both, then dictate again; meanwhile the transcript is already in the clipboard, so `⌘V` works.
- **A permission prompt never reappears:** macOS remembers the denial. Reset the grants in Terminal and relaunch Sotto:

  ```bash
  tccutil reset Microphone com.sotto.desktop
  tccutil reset AppleEvents com.sotto.desktop
  tccutil reset Accessibility com.sotto.desktop
  ```

- **Sotto quits immediately after launching:** Check that the Mac has Apple silicon (Apple menu → About This Mac). Intel Macs are not supported and the arm64 build cannot run on them.
