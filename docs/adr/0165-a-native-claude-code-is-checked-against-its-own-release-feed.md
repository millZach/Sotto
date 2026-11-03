# A native Claude Code is checked against its own release feed

## Status

Accepted October 30, 2026, by Zach's pick "Check the native feed" for #1913. **Number provisional until merge** (docs/agents/domain.md).

It is a fix to an existing feature and goes straight to stable; it is not an Owl feature (ADR-0072). Amends [ADR-0042](0042-provider-client-updates.md), whose published version for every npm package came from the npm registry, and adds one host to the README's "Privacy and cost" list.

## Context

On Zach's Windows laptop, Settings > Providers offered "Update to 2.1.316" for Claude Code, and Update failed every time. Claude Code there is the native install: `~\.local\bin\claude.exe`, 2.1.314, with `autoUpdatesChannel` set to `latest` in `~\.claude\settings.json`. ADR-0042 already has Sotto update an install like that with `claude update`, Claude Code's own updater, and that was the right install and the right updater. But Sotto read the newest version from npm's `latest` tag for `@anthropic-ai/claude-code`, which said 2.1.316, and the native updater reads a different feed:

- `https://downloads.claude.ai/claude-code-releases/latest` answered 2.1.314.
- `.../stable` answered 2.1.308.
- `.../2.1.316/manifest.json` existed, built at 23:47 UTC that day, but neither channel pointed at it yet.

So `claude update` found nothing newer and exited cleanly, the client still reported 2.1.314, and Sotto said the installer finished but Claude Code still reported 2.1.314. Nothing was downloaded, and running `claude.exe` processes were not the cause: ADR-0042 already records that Claude Code's updater replaces `claude.exe` while sessions run. npm publishes first, and the native channel catches up hours later. Until it did, every Update press failed and the row kept offering the press.

There were two ways to fix this. One was to keep npm as the source and change what the row says when the native updater has nothing newer yet. The other was to ask the feed the native updater reads. Zach picked the feed.

## Decision

**A native Claude Code is compared with its own release channel.** When Claude Code is the `self-update` channel (its own installer's copy in `~/.local/bin` or `~/.claude`, with no npm package or mise install claiming it), Sotto reads the channel it follows from `autoUpdatesChannel`, where Claude Code reads it. Managed settings come first, because Claude Code lets nothing override them: `managed-settings.json` in Claude Code's system folder (`C:Program FilesClaudeCode` on Windows, `/Library/Application Support/ClaudeCode` on a Mac, `/etc/claude-code` on Linux), then each `*.json` in its `managed-settings.d` folder in name order, the last one that names a channel winning. Without one, the user's own `settings.json` decides, in `CLAUDE_CONFIG_DIR` when that variable is set, else in `~/.claude`. The channel is `latest` or `stable`, and `latest`, Claude Code's own default, when nothing names one or a file cannot be read. Sotto then asks `https://downloads.claude.ai/claude-code-releases/<channel>` for the version, and "Update to" shows only when that version is newer than the one installed. So the press is offered only when `claude update` can install something.

- The request carries the channel name and nothing else, like the npm and Muse checks. It follows "Check for client updates", runs on this computer and on each host, uses the same four-minute keep and the same ten-second limit, and refuses redirects.
- The answer must be one version on one line (digits and dots, with an optional `-` suffix) and at most 64 bytes. Anything else, or no answer, claims nothing: the row says the installed version and offers no update, as a failed npm check does.
- Only `autoUpdatesChannel` is taken from those files. Managed settings that reach Claude Code another way, such as the Windows registry policy or a macOS configuration profile, and a `--settings` flag are not read, so on a machine set that way the row follows the files.
- An npm install of Claude Code is still compared with npm's `latest` and updated with npm, and a mise install still asks mise for npm's version by name (ADR-0042). Each channel is compared with what its own updater installs.

## Consequences

- Sotto contacts one more host, `downloads.claude.ai`, and only for a native Claude Code. The README's "Privacy and cost" section names it.
- A native install learns of a release when its channel does, which can be hours after npm. That is when `claude update` can install it.
- If Anthropic moves the feed or changes what a channel answers, the check claims nothing and the row offers no update until Sotto follows it. It never offers a version it could not read.
