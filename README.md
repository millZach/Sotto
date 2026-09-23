<div align="center">

<img src="build/icon.png" alt="Sotto icon" width="96" />

# Sotto

**Dictation that spells your world right, with a desktop control center for your agents in development.**

Sotto is a dictation app for Windows and Apple silicon Macs. Press the global shortcut, speak, press it again, and Sotto copies the transcript and optionally pastes it at the active cursor. Transcription runs on Microsoft MAI-Transcribe-2 through OpenRouter with your own API key, and your personal dictionary is sent along as spelling hints so names and product terms come back the way you write them.

[![Latest release](https://img.shields.io/github/v/release/millZach/Sotto-releases?label=release&color=e8833a)](https://github.com/millZach/Sotto-releases/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20x64%20%C2%B7%20macOS%20arm64-2f6f6a)](https://github.com/millZach/Sotto-releases/releases/latest)
[![Transcription](https://img.shields.io/badge/transcription-MAI--Transcribe--2%20via%20OpenRouter-2f6f6a)](#privacy-and-cost)
[![License](https://img.shields.io/badge/license-freeware-555)](LICENSE.md)

<img src="artifacts/design/baseline/listening-dark.png" alt="Sotto recording widget while listening" width="260" />

**[⬇ Download the latest installer or disk image](https://github.com/millZach/Sotto-releases/releases/latest)**

</div>

---

## Why Sotto

- 🎯 **Spells names right** — the words in your personal dictionary are sent with every request as spelling hints. In our bench that took proper-noun accuracy from 56% to 100% on the same audio.
- ⚡ **One shortcut, anywhere** — a global hotkey works in any app. Sotto always copies the transcript to the clipboard and can paste it at your cursor automatically.
- 🗣️ **One transcription model, no setup** — Microsoft MAI-Transcribe-2 through OpenRouter. Paste an API key once; there is nothing to download, pick or tune.
- ✨ **Optional AI cleanup** — punctuation, fillers, self-corrections and spoken lists, using the same OpenRouter key, with a silent fallback to the raw transcript when the network is slow.
- 🔒 **No account, no telemetry** — Sotto has no analytics or crash upload. Audio is never written to disk, and transcript history stays on this computer.
- 💸 **Free app, pay-as-you-go transcription** — no Sotto subscription. OpenRouter bills about a cent per hundred short dictations.

Sotto was formerly named TalkType; version 3.0.0 renamed the app and its visual identity. On first launch, Sotto automatically migrates settings and history from an existing TalkType installation.

## Requirements

### Windows

- Windows 10 or Windows 11, x64
- A working microphone and permission for desktop apps to use it
- An OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys) and an internet connection while dictating
- At least 1 GB of free space during installation for the installer, temporary extraction, the app and safe working headroom

### macOS

- macOS 11 (Big Sur) or newer — TODO(mac-bringup): replace with the LSMinimumSystemVersion read from the built bundle
- Apple silicon (arm64) only — Intel Macs are not supported
- An OpenRouter API key and an internet connection while dictating
- At least 1 GB of free space while the disk image is mounted and copied into Applications
- A working microphone and microphone permission for Sotto in System Settings → Privacy & Security → Microphone
- Automation and Accessibility permission for Sotto if you want automatic paste; without them Sotto still copies every transcript to the clipboard

Node.js 22 or newer is needed on either platform only when developing from source.

## Privacy and cost

When you connect a remote host, Sotto sends your thread reads, prompts and explicit request answers to the host you configured. The host socket listens only on its own loopback address. The desktop reaches it through your SSH connection. Pairing identifies each client and can be revoked. Provider credentials stay on the host, and pairing does not approve permission requests. No public listener, relay account, analytics or new provider service is enabled by connecting a client.

The Tools browser contacts the HTTP(S) pages you open, including local development servers, and the subresources those pages request. Browser agents use Sotto's own pages through thread-scoped tools; providers that require MCP connect to an authenticated endpoint on `127.0.0.1` on this computer. When you authorize browser work or send selected page context, its screenshots and relevant page data go to that thread's provider under the provider's data policy. Sotto keeps browser-task evidence and page grants in memory, never in operational logs. Explicitly attached/sent material follows the existing draft and history controls. See [the browser decision](docs/adr/0020-sotto-owned-browser-tasks.md).

Dictation audio is uploaded to OpenRouter and transcribed by Microsoft MAI-Transcribe-2 only while you dictate. Your personal dictionary words travel with each request as spelling hints, and the text comes back. Nothing is transcribed on this computer, so Sotto needs your OpenRouter key and a network connection to dictate; when either is missing, Sotto says so instead of transcribing elsewhere. OpenRouter charges your balance at the model's published audio rate (about $0.10 per hour of audio at the time of writing). Read [OpenRouter's privacy policy](https://openrouter.ai/privacy) for what it and its providers retain.

Sotto has no analytics or crash upload. Dictation audio is never persisted. Transcript history is local, optional, bounded, searchable, and clearable. Two small diagnostic files in Sotto's data folder help explain a lost dictation: `polish-diagnostics.jsonl` records word counts around AI cleanup, and `transcription-diagnostics.jsonl` records why a transcription request failed (reason, HTTP status, attempts, clip length and time taken). They hold no words, audio or keys, each starts over past 256 KB with one older copy kept, and neither leaves this computer.

Devin CLI uses your native Devin account and its separate billing, data policies, local session storage, and usage analytics. Keep local history controls only Sotto's copy; it does not erase or disable Devin's records. Review your native account's training and retention controls. The tested native account route contacts server.codeium.com for the service and o4507463137361920.ingest.us.sentry.io for provider telemetry. Devin starts disabled. Its tested Windows baseline is CLI 3000.10.31; Apple silicon verification is still pending. See the [Devin data-policy decision](docs/adr/0017-devin-native-provider-data-policies.md).

Thread titles, new worktree branch names, commit message drafts and pull request drafts are written by the thread's own provider: Claude Code, Codex or Grok Build, on your account and the thread's model, in a separate one-off request that never enters the thread's own conversation. None of these four goes to OpenRouter or anywhere the thread was not already going. With Generated thread titles and Keep local history on, the provider is sent the thread's first message and first reply, each capped at 2,000 characters, to name the thread, and a new worktree's first prompt alone, capped at 2,000 characters, to name its temporary branch; no branch request is made for a shared project folder or an existing worktree. The commit form sends only the staged diff. The Git action that commits from one press sends the staged diff, the names of the staged files, the repository's last twenty commit subjects and its `AGENTS.md`, so the message follows the house style, and the pull request text is written from the branch's commit subjects, its file list, a capped diff and the repository's own pull request template where it has exactly one. When the provider writes nothing, the action commits under the subject "Update project files" rather than waiting. The action stages what it commits itself, everything or the files you chose, so anything staged by hand beforehand is staged again from the working tree; and it reads the remote first, under the same 15-second rule as a refresh. These requests count against the provider's usage limits like any other, at the lowest effort the thread's model offers. Devin threads keep their placeholder name and open the forms empty, because Devin cannot answer once without keeping a session of its own. A failed or disconnected provider leaves the placeholder name, the temporary branch or an empty form, and the turn continues. Turn off Generated thread titles to stop both kinds of automatic naming. See [ADR-0026](docs/adr/0026-short-writing-runs-on-the-threads-own-provider.md). Choosing an origin branch under Start from for a new worktree fetches that branch from the project's configured Git origin before setup; Git contacts that remote using its existing authentication. The worktree cleanup rule "when its pull request is merged" asks GitHub once an hour, through the `gh` command and its own sign-in, whether each candidate branch's pull request is merged; the other rules read only the local repository and contact nothing. All of them are off until you turn one on. While the Sotto window is in front, Sotto also fetches each open thread's project from its Git origin at the **Git fetch interval** in Settings (every 30 seconds unless you change it, or never when it is Off), and when you refresh a thread's working copy, no more than once every 15 seconds, so the thread's branch knows whether it is ahead of or behind the remote; the fetch uses Git's existing authentication, never answers a prompt, and sends nothing but the fetch itself. On the same schedule, and whenever you refresh a thread's working copy, Sotto asks GitHub through `gh` on your own sign-in whether the branch has a pull request, for branches that have been pushed. See [ADR-0027](docs/adr/0027-git-the-way-t3-code-does-it.md).

Automatic update checks are on by default. Shortly after launch and then every few minutes, the installed Windows app asks the GitHub releases page whether a newer version exists, which means GitHub sees an ordinary web request from your computer: IP address, time, and the version you are running. No audio, transcripts, settings, or identifiers are sent. When a release is found, the update control at the end of the sidebar foot offers it: one press downloads it, the next press asks before restarting into the installer, and nothing is installed behind your back when you quit. The whole check can be turned off under Settings → Updates, and "Check for Updates…" in the tray menu (the application menu on macOS) runs one on demand.

Client update checks are on by default. When a provider connects, and at most once an hour for each one, Sotto asks the npm registry (registry.npmjs.org) which version that client publishes: Claude Code, Codex and Grok Build. The request carries a package name and nothing else, and npm sees an ordinary web request from your computer. Devin is never asked about, because it ships inside the Devin app and updates itself. When a client is behind, a card in the bottom-right corner names the installed and published versions, and one press installs it the way that client installs: `npm install -g` for a package npm owns, or the client's own updater when npm does not own it. The provider disconnects first, because a running client cannot be replaced and a turn in flight would be lost, and reconnects when the update finishes. A provider with a thread working says so and waits for you to say "Update anyway". If the installer finishes but the client still reports its old version, because another window is holding it open, Sotto says that rather than calling it updated. An install Sotto does not recognise shows the command to run instead of a button. Turn the whole check off with "Check for client updates" in Settings → Providers, which also carries each client's installed version and a Check again press.

Optional AI cleanup is off by default. When you enable it, the finished transcript (never audio) is sent to OpenRouter with the same key for punctuation and self-correction cleanup. If the network is slow or offline, Sotto delivers the raw transcript instead. Optional agent control also sends the prompts you submit to the connected harness and, when configured, sends assignment text and relevant thread context to your selected reasoning provider. Agent replies default to Grok Altair, which sends reply text to xAI using a separately saved xAI API key. Kokoro Heart is a lower-cost choice that sends reply text through OpenRouter using the existing OpenRouter key. Voice previews incur the same provider usage charges; neither option silently falls back to another provider. The optional natural voice is generated on this computer after a one-time voice download. Provider usage is billed separately from Sotto access. Credentials are encrypted using the operating system credential store and are not returned to the UI.

## Headless host (development)

The host can run under Node 24 on Windows or Linux without Electron or a display. It owns its providers, worktrees and saved history. Build from a checkout with `npm ci` and `npm run build:host`, then run:

```sh
# From a checkout, after npm run build:host
node out/host/index.js --data /path/to/sotto-data --key-file /path/to/private/sotto-key
```

From an extracted host archive the entry is `host/index.js` instead of `out/host/index.js`; the commands below use that form.

`SOTTO_HOST_DATA` and `SOTTO_HOST_KEY_FILE` provide the same options. The data folder must be explicit. Use a dedicated host folder; desktop credentials use the operating system store and cannot be opened with a host key file.

The key file contains a user-supplied secret of at least 16 characters. Keep it outside the data folder, restrict access to your account, and back it up separately. Sotto encrypts credentials with scrypt and authenticated AES-256-GCM using Node builtins. It never saves the key beside them. A missing or wrong key, or a damaged credential file, stops startup without replacing that file. You may omit the key file while no credentials have been saved; saving a credential then requires restarting with one. Native provider sign-ins remain with their installed clients.

Settings are read from the data folder at startup. The headless entry exposes `startHeadlessHost({ dataDirectory, keyFile })` in-process; its `service` is the same `HostService` that the desktop uses. `close()` drains provider and reasoning processes and durable writes. The command-line host handles SIGINT and SIGTERM and opens an authenticated loopback listener. Add `--port 4319` to keep a fixed port, or omit it to choose an available port. Readiness output names the host and port. The private `host-listener.json` file includes a local administration credential; do not share it. An embedded host opens a listener only when given a `port` option.

Run `npm run test:host` for the plain-Node lifecycle and `npm run test:socket` for authenticated child-process client journeys. `npm run package:host` creates an archive and checksum with the platform in its filename, then extracts and smoke-tests it. See [host packaging](docs/release/releasing.md). Deployment to a real Linux machine still needs a live check.

A normal stop removes the host's listener descriptor and lock. After a crash or a reboot, the next start finds the old `host-listener.lock`, checks that the process it names is gone, and takes the folder over; nothing needs cleaning by hand. If that process is still running, startup refuses and names it, and a lock file it cannot read is left for you to look at. Only one host may use a data folder at a time. The SSH account needs `node` on the path of a non-interactive shell, because the desktop starts the host with a plain `node` command. When Sotto starts the host over SSH it passes no key file, so a data folder that already holds saved credentials needs `SOTTO_HOST_KEY_FILE` set for that account.

A remote host keeps its own OpenRouter key, in its encrypted credential file, and never receives the desktop's: a paired client cannot send a credential. Without a key there, OpenRouter-hosted reasoning on that host stays off. Thread titles, branch names and Git drafts need no key on a host: the provider running each thread writes them (ADR-0026).

## Remote hosts (development)

In **Settings > Hosts**, add any machine you reach over SSH and have installed the host on: its SSH target, the extracted host installation folder and the host data folder. Add as many as you like; each connected host's threads appear in the sidebar with the host's name, and one host is selected for new threads. The desktop uses your SSH configuration and asks before accepting a new host key. Connect starts or discovers the installed host and forwards its loopback listener, then Sotto pairs this computer itself over that connection; no code is typed.

A host Sotto started keeps running until you stop it. Disconnect, quitting Sotto and a dropped connection all leave it working, so another paired client can keep using it and running turns finish; a dropped connection reconnects on its own. **Stop host** stops a host Sotto started and disconnects; **Forget** revokes this computer's access, stops a host Sotto started, and removes the saved connection. A host you started yourself is never stopped by Sotto. You can Forget a host you can no longer reach; this computer's access on it then stays until you revoke it there with `--revoke-client`.

A client that cannot pair itself over SSH enters a code shown on the host instead. On the host, from the extracted host folder, request a fresh code:

```sh
node host/index.js --data /path/to/sotto-data --pairing-code
```

The code expires after five minutes. Pairing admits this device; permission answers need a separate policy grant from the host's user. Use the client ID the client shows, or the one saved for a desktop connection, to grant, deny or revoke access explicitly:

```sh
node host/index.js --data /path/to/sotto-data --allow-answers CLIENT_UUID
node host/index.js --data /path/to/sotto-data --deny-answers CLIENT_UUID
node host/index.js --data /path/to/sotto-data --revoke-client CLIENT_UUID
```

Choose **Use this host** for host-wide actions. Threads from connected hosts share one sidebar and show their host name when more than one is connected. Their identities, drafts and actions stay separate. Turning **Run the local host** off takes effect after **Restart Sotto**, leaves saved data intact and keeps dictation available. Folder and terminal tools for a remote thread explain that they run on the host machine. Dictation and paste remain on the desktop computer. Provider credentials, account setup and host administration stay on the host.

After an interrupted command, reconnect and check its result before choosing to send again; Sotto never automatically repeats it.

An iPhone client is planned in its own pull request ([#225](https://github.com/millZach/Sotto/pull/225)) and is not part of this build. Its setup, including the private address it reaches the host through, arrives with it.

## Agent control center (development beta)

Codex model, effort and permission changes use its native settings update and wait for confirmation. An interrupted change does not disconnect the provider. If Codex cannot confirm it, the affected thread asks you to choose its settings again before sending. Other threads remain available; reconnecting does not replay the settings change.

The **Agents** view coordinates threads running in installed Codex, Claude Code, Grok Build and Devin clients, collects prompts until you say **“send it,”** and supervises only the threads you assign. It queues questions one at a time and yields a thread to manual control when you send directly in the native client. Connect clients independently in **Settings → Providers** and choose a model for each thread. The model chip opens a two-column menu: the connected providers as a rail of marks down the left, and that provider's models on the right under a search line. The permissions chip beside it lists what a thread may do without asking; on Devin it lists Devin's own modes, each saying what Sotto will still ask you about under it. A model is listed under the fullest name its provider gives it, version and all, and the one the provider recommends stays at the top. **Settings → Agents**, below Hosts, configures Sotto's separate coordinator inline for deep reasoning and thread management. The floating widget retains click-to-dictate and dragging. In a thread composer, open the effort chip to slide between the model’s supported reasoning levels; each level says what it costs. Release to choose, or use the wheel, the arrow keys, Home, End or the digits, and **Default** returns to the model’s own level. A new thread starts on that level unless you choose another; for Grok it is the level Grok marks as its default, not the one set in Grok’s own settings. The level you choose shows at once and the card stays usable while it is saved, so you can keep moving; the provider has the last word, and a change it will not take goes back to the level you were on and says the change could not be confirmed. At the model’s highest level the word, the chip and the composer’s outline take the **Effort color** chosen in **Settings → Appearance** (Ember, Cyberpunk, Rainbow, Aurora, Plasma or Theme accent), and reaching it plays a short wash of that color; reduced motion shows the finished state. Claude’s **Add Ultrathink to prompt** puts a visible instruction in the current draft without changing effort or permissions. Ultracode workflow orchestration is not currently exposed in Sotto.

Model questions with choices appear above the thread's message bar. Pick an answer or type in **Write my own answer**, then press **Send answer**. The model's suggested option is marked **(recommended)** when it supplies one; nothing is selected for you. Enter adds a line to a custom answer. Escape collapses the question, and reopening it keeps your answer. Prepared choices also survive restarting Sotto. Long forms scroll inside the panel, while your message draft stays separate. In a very short split pane, collapse the question to return to reading the thread. Pending permissions and saved-answer recovery remain reachable by scrolling the pane. Questions without supplied choices keep their text-answer path.

A thread's messages and retained activity are Sotto's own record, kept in `threads.sqlite` in the app's data folder rather than rebuilt from the provider each time Sotto starts. A thread pane opens on its newest ten turns; press **Show earlier messages** above the oldest one to read further back. A provider session starts when you open or send to a thread, not at connect, and one left idle for thirty minutes is stopped until the next time it is needed. With **Keep local history** off, no message text or activity output is written to disk; turning it off removes the text already written, and what was not kept cannot be recovered. See [ADR-0016](docs/adr/0016-sotto-owned-history-on-an-event-store.md).

This is an unreleased development feature. Native clients retain their own subscription sign-in and model catalogs. Wake control requires separately supplied compatible local model/runtime files; their distribution, real microphone acceptance, and macOS live checks remain release gates. Production sign-in, checkout, and billing webhooks are not deployed. Until a membership service is configured, every build, installed or unpackaged, labels access **Private beta** and allows agent actions; that is not a paid entitlement.

Paste a screenshot into a thread's prompt, drag it in, or choose **Attach screenshots**. Codex models that accept images and Claude Code models support screenshots; text-only models keep the control unavailable. Send an image on its own or alongside text, with up to eight images, 10 MB per image and 20 MB total. Grok Build currently cannot receive screenshots through its native client.

Read the [agent setup and behavior guide](docs/agent-control.md), [implementation evidence and remaining gates](docs/verification/issue-9-implementation.md), and [membership service contract](docs/verification/issue-9-membership-service.md) before using or distributing this feature.

When Claude Code reports an active monitoring task, a small pixel creature walks above the composer with a magnifying glass and the task name. It appears immediately for a confirmed watch, including a brief one, and leaves when the watch ends, the thread disconnects, or your answer is needed. Ordinary commands and unattended background processes do not trigger it. Reduced motion holds a still inspection pose. Codex, Grok Build and Devin stay hidden until their native events can confirm the same lifecycle.

When Claude Code reports that a workflow, subagent, teammate or remote agent started from a thread is still running, the same creature stands by the readout and sends small agents out along the track, one for each task, up to six. The readout names the first task and says **Working**, or *Working · 3 agents* when there are several; hover it to see them all. It stays after the turn ends, for as long as Claude Code says the work is running, and leaves when the work finishes, you stop the thread, it fails or disconnects, or your answer is needed. A subagent the turn is still waiting on shows the hourglass instead. While it shows, changing the thread's settings and rewinding it wait for the agents to finish, because either would restart Claude Code and end them. A confirmed monitoring task takes the space first. Reduced motion stands the small agents still in a line.

When one command, tool call or subagent has held a thread for twenty seconds or more, the same creature stands there instead with an hourglass, showing what is running and how long it has run. It reads the thread's own activity rather than any one provider's events, so it is not tied to Claude the way the monitoring creature is; it appears on Claude Code, Codex, Grok Build and Devin threads alike. It says only that time is passing: nothing is being watched on your behalf, and nothing is approved. A confirmed monitoring task or running background work takes the space instead, and a pending question or permission clears it, as before. Reduced motion holds a half-run glass.

The Threads sidebar keeps each thread’s provider, status and last activity beneath its project. Drag its right edge to resize it; a wider sidebar reveals the branch, model and working copy. Collapse sidebar makes more room for the conversation, and Expand sidebar restores the width you chose. With the divider focused, arrow keys resize it, Home and End choose the limits, and a double-click resets it. Creating a new thread in a settled project returns the folder to the active sidebar with only the new thread; older threads stay in Settled.

Hovering a message or a finished reply shows a copy control at its top corner. One press copies it as Markdown, so code blocks, lists and tables paste intact somewhere else. Right-click the control, or press Shift+F10 with it focused, to copy as plain text instead. A reply still being written has no copy control, and each code block keeps a copy button of its own.

You can create a thread from the Threads page while another thread has a saved coordinator draft. The draft stays with its original thread, including while the voice coordinator is hidden for the beta.

New threads inherit the native agent and model selected in **Settings → Agents**, including its reported default model when no model is selected. An unavailable selection waits until it connects or you choose another model in **Thread options**. Earlier separate defaults for new threads no longer override Agents. With no native agent selected (Not configured or an API account), Sotto starts with an available native thread provider.

New threads use the **Project folder** by default, including its uncommitted edits. Threads in that folder share files and branch. **Thread options** in New thread holds the optional name, model, reasoning and permissions; the working copy is chosen under the composer once the thread is open. There, for a Git repository, the **branch toolbar** shows **Run on** (the machine the thread runs on), **Workspace** (**Current checkout**, **New worktree** for independent parallel work, or **Previous worktree** to reuse a worktree another thread of the project has), the branch's pull request, and the **branch picker**. Workspace locks after the first message. The picker searches the repository's branches and switches the folder to the one you pick, creates a tracking branch for a remote one, offers **Create new ref** for a name that does not exist, and for a new worktree records the branch it starts from with a **Start from origin** switch that fetches that branch on first send. Uncommitted project edits stay in the project folder. Settings under Application sets the global default; expand **Project defaults** there to override it for a project. Existing threads keep their folders and unfinished work.

The branch label follows the actual checkout. A shared project folder that changes branches can show a dismissible notice while you draft; sending continues on the current branch. **Restore branch** switches back by your choice, asking first about uncommitted changes. Worktree-backed threads follow their branch without that notice.

A worktree is a full checkout, and an agent that installs dependencies in it can leave a gigabyte or more behind. You can give the folder back: **Remove worktree** in the thread's working-copy control removes the folder and keeps its branch, and settling a worktree-backed thread asks whether to remove its worktree too. Sending to the thread again puts the folder back on that branch. A folder with uncommitted changes is removed only after you confirm that they are lost. Settings under Application also offers rules that remove a clean worktree on their own: after it has been idle for a chosen number of days, when its thread is settled, when its commits are all in the repository's default branch, or when its pull request is merged. Every rule is off unless you turn it on; none of them touches uncommitted work or a folder holding anything but installed dependencies in its ignored files.

While a thread is running, **Steer now** beside a queued message sends that message into the current turn when the provider supports steering. The rest of the queue and any newer composer draft stay in place. An unconfirmed message cannot be steered again; use **Check again** to reconcile its delivery.

Open **Tools → Agents** in a thread to see its reported subagents. Each row shows the task, the model it ran on, status and elapsed time when known; a Claude Code workflow row lists its agents' models. Open a row for its task and result, including earlier assignments when an agent is reused. Children appear under their reported parent. **Load earlier agents** reads older entries without loading the whole history at once.

A small dot above-left of the Tools icon means agents are working in the thread Tools follows, including a pinned thread, or that a browser request there is waiting for your answer. Opening Tools keeps the surface you last used. Inside Tools the surfaces (Browser, Terminal, Files, Changes and Agents) sit on a rail at the panel's outer edge; a dot on one means something is live there: a browser task working or waiting, changed files, or agents working. Away from Changes, its dot follows the check Sotto makes of the working copy after each turn, so a change you make yourself in the terminal shows in Changes at once but lights the dot only after the thread's next turn. **Pin**, **Expand tools panel** and **Close tools panel** sit at the rail's foot, and the working copy Tools reads is the panel's footer: the project, the branch when it is known, and the kind of folder. After a disconnect or restart, **Last seen working** means current activity has not been confirmed; the clock and dot wait for fresh provider evidence. Finished agents remain in local history independently of the transcript's activity limit. **Keep local history** controls whether this roster and its task text are saved. Turning it off erases saved tasks and results while unfinished agents keep their status and generic task labels. If you turn it back on, erased assignments stay text-free, including later results; fresh assignments are saved again.

Codex, Claude Code and Grok can use the browser in **Tools** to inspect and check a page. A corner thumbnail shows the active task; click it to open that same page without changing your conversation. **Pause** stops further browser actions, while dismissing the thumbnail leaves the work running. Open, navigation, click and typing requests wait for your one-time answer. On a request to open a page, **Allow this thread to open pages** also lets that thread open and go to pages without asking until you press **Stop** in Tools > Browser or Sotto closes; clicks and typing still ask every time. The corner thumbnail shows only the task of the focused thread or the thread Tools is pinned to, and **Show browser previews** in Settings turns it off without stopping the work; a waiting request still puts a dot on the Tools icon of the pane showing its thread. Pages you open yourself must be shared before an agent can observe them.

Select an element or region, add a comment, and attach it to the thread's editable draft. Finished tasks retain observed steps, screenshots and unchecked cases for the app session. Image attachments depend on the provider's capabilities. Devin's pinned native client does not support the Sotto browser connection, so its browser is available for manual use and draft feedback only. See [browser tasks](docs/agent-control.md#browser-tasks-in-tools) for details.

## Install and first run

### Windows

Run the `Sotto Setup <version>.exe` installer and choose the per-user installation folder. The desktop shortcut is optional and unchecked by default; the installer always creates a Start Menu shortcut. Uninstalling removes either shortcut but preserves settings and history by default so an accidental uninstall does not silently destroy local data.

Upgrading from TalkType: because the application identity changed in 3.0.0, Sotto installs alongside TalkType instead of replacing it. Your data migrates automatically the first time Sotto starts; uninstall TalkType afterward from Windows Settings → Apps.

Locally built artifacts are not code-signed because no Windows signing certificate is stored in this repository. Windows may therefore show an **Unknown publisher** or SmartScreen prompt. A public release should be Authenticode-signed by its distributor without changing application behavior.

### macOS

1. **Copy the app to Applications.** Open `Sotto-<version>-arm64.dmg` and drag **Sotto** onto the **Applications** shortcut in the same window, then eject the disk image and launch Sotto from Applications. Do not run Sotto from the mounted image: macOS App Translocation launches downloaded apps from a randomized read-only path, which changes the app location on every launch and makes permission grants and settings unreliable.

2. **Allow the unsigned build to open.** Sotto is ad-hoc signed but has no Apple Developer signature, so the first launch is refused with a message such as *"Sotto" is damaged and can't be opened* or *macOS cannot verify that this app is free from malware*. Open **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the message about Sotto, then confirm and launch Sotto again. Use this path first: macOS 15 and newer no longer offer the old Control-click → Open bypass for this case. As an alternative, clear the quarantine flag in Terminal and launch normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Sotto.app
   ```

3. **Grant the permissions Sotto asks for.** The first dictation asks for microphone access. The first automatic paste asks for Automation ("Sotto wants to control System Events") and needs Sotto enabled in **System Settings → Privacy & Security → Accessibility** as well. Denying or missing either grant never loses a transcript: Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard, and automatic paste starts working as soon as both grants are in place.

4. **Expect the permission prompts again after every update.** macOS keys these grants to the app's code signature, and an ad-hoc signed build gets a fresh identity on every rebuild. After installing a new version, macOS treats Sotto as a new app and asks for microphone, Automation, and Accessibility again; a stale entry may need to be removed from the list before the new one takes effect. This stops once Sotto ships Developer ID-signed builds.

### First run

First-run setup explains what leaves the computer, tests microphone access, takes your OpenRouter API key (you can add it later in Settings), and shows the active shortcut and safe paste-test field. The default global shortcut is `Ctrl+Shift+Space` on Windows and `⌃⇧Space` (the literal Control key) on macOS. Press it once to start and again to stop and transcribe. `Escape` cancels an active session.

Sotto closes to the Windows notification area or the macOS menu bar. Use that menu to show the window, start or stop dictation, toggle automatic paste, or quit completely. On macOS the Dock icon appears only while the Sotto window is open; the menu-bar icon is always there.

## Settings

- Dictation: microphone, global shortcut, recording limit, local sound cues, and streaming transcription so long dictations finish almost immediately after you stop
- Transcription: MAI-Transcribe-2 through OpenRouter (the only model), your OpenRouter API key with a verify button, language, and conservative whitespace formatting
- Cleanup: optional AI cleanup with quality tiers and the personal dictionary that also feeds transcription spelling hints
- Output: mandatory clipboard safety copy, optional automatic paste, paste delay, and success-message duration
- Appearance: the color scheme (Light, Dark, or match the system), then one theme for light mode and one for dark, chosen in two columns. Sotto ships six themes of its own: Sotto, Hush, Linen, Nocturne, Tropic and Citrine. Sotto is the default, with an almost-black dark room and the app icon's teal (a deeper teal in light mode, so text and links stay readable). You can create a theme, import a T3 Code or VS Code theme file, or install one from Open VSX. Below the themes: the effort color, contrast and glass. A light or dark half saved on one of the older built-ins (Rose, Fern, Tide, Copper or Dusk) returns to Sotto.
- Updates: the version you are running, an automatic GitHub release check that is on by default and can be turned off, and a manual check (the update control in the sidebar foot, the tray menu and the macOS application menu run the same check)
- Application and privacy: launch at login, start minimized, local history, retention, clear history, and reset settings

Automatic paste is best effort. Windows blocks synthetic input into elevated applications, password fields, protected desktops, and some custom editors. macOS blocks it in secure input fields and until both the Automation and Accessibility grants exist. When paste is rejected, Sotto shows **Copied — paste manually** and leaves the complete text in the clipboard. If a Windows target app is running as administrator, either paste manually or run both apps at the same integrity level.

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

## Test matrix

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run runtime:verify
```

Unit and integration tests cover settings recovery, history privacy, audio math and lifecycle, the OpenRouter transcription request and its failure reasons, runtime integrity, IPC validation, hotkeys, clipboard-before-paste output, startup, tray, window security, transcription orchestration, and widget synchronization. Electron end-to-end tests use an admitted non-packaged boundary with deterministic in-memory microphone, shortcut, clipboard, paste, startup, tray, and transcription adapters. They cover onboarding, registered-hotkey dictation, in-app paste, history on/off, theme and settings reload, hotkey conflict, microphone denial recovery, silence, paste fallback, hide-to-tray, single-instance behavior, and transcription failure. Widget visual tests verify ten 420x92 light/dark state images and transparent corners.

The deterministic boundary is rejected in packaged builds and accepts calls only from the trusted main renderer. It never logs transcript text or PCM.

Every push to `main` and every pull request against it runs typecheck, lint, `vitest run` and the third-party notices check on a Windows runner (`.github/workflows/ci.yml`). Desktop end-to-end tests and live provider suites stay local. A separate Linux job checks the host archive and socket contract. See the [continuous integration guide](docs/ci.md) for what each step does and how to read a failed check.

## Build Windows artifacts

```powershell
npm run package:dir
npm run package:win
```

Artifacts are written to:

- `release/win-unpacked/Sotto.exe` — unpacked x64 application
- `release/Sotto Setup <version>.exe` — assisted, per-user x64 NSIS installer

Brand assets (`build/icon.png`, `build/icon.ico`, `build/installer-sidebar.bmp`) are generated from the SVG masters in `build/` with `node scripts/generate-brand-assets.mjs`.

The packaged `resources` directory contains `runtime/`, `README.md`, and `THIRD_PARTY_NOTICES.md`. Each packaging command automatically verifies the source runtime before packaging and verifies the packaged runtime, notices, bridge and worklet afterward.

## Build macOS artifacts

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

## License

MIT License
