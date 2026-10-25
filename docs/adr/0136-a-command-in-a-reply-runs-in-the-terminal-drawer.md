# A command in a reply runs in the terminal drawer

## Status

Accepted October 25, 2026, as an Owl feature (`run-command`). Drake Morey picked A of `docs/prototypes/run-command-prototype.html`: Run appears over a command when it is pointed at or focused, and a press runs the command in a new Terminal drawer shell. Builds on the pane's own drawer ([ADR-0049](0049-a-thread-pane-has-its-own-terminal-drawer.md)) and [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md) (Owl features). **Number provisional until merge** (docs/agents/domain.md).

## Context

Replies often tell the user to run something: `brew install --cask osquery santa`, then a script, then a block of checks. Today the user selects the text, copies it, opens the drawer and pastes it, one command at a time. The drawer is already under the conversation and already starts in the project folder.

## Decision

**1. The user's press is the grant.** A **runnable command** offers a Run control. Nothing runs until the user presses it, and each press runs it once. Nothing a reply writes runs by itself, and nothing Sotto sends on the user's behalf presses Run. A provider's permission requests are untouched: they are still answered only by policy records ([ADR-0004](0004-authority-in-policy-records.md)). The command runs as the user, in the user's shell, the same as if they had typed it.

**2. It runs in a new drawer shell.** A press opens the pane's Terminal drawer and starts one new shell there, in the project folder like any drawer shell, as the active tab, named after the command's first line. It is never typed into a shell that is already open: that shell could be in another folder, halfway through a prompt, or running a program that would take the text as its own input. Opening the drawer for Run does not also start the drawer's usual empty shell. The new shell counts against the shared 32-terminal limit; at the limit, the drawer says so in its usual words and nothing runs.

**3. Main types the command.** The create request carries the command as `run`, and main writes it to the new terminal right after it spawns, in the same step, so the window's snapshot replay cannot drop it. Main accepts `run` only for a drawer shell and only while the feature is on, read once at start, and refuses anything else as an invalid request. The command never reaches a log.

**4. What counts as a command.** One pure rule, `src/shared/runnableCommand.ts`, used by the window and by the request schema:

- A fenced block is runnable when its language is `bash`, `sh`, `zsh`, `shell`, `console`, `terminal`, `powershell`, `pwsh`, `ps1` or `cmd`. A block with any line starting with a prompt, `$ ` or `> `, or for PowerShell also `PS> ` or `PS C:\work> `, is a transcript: only those lines run, without the prompt, and the other lines are output. A `console` or `terminal` block with no prompt line holds only output and is not runnable.
- An inline code span is runnable when it is one line whose first word is a lower-case program name or a path (`./`, `../`, `/`, `~/`), and it has a space after that word or the word is a path; or when its first word is a PowerShell cmdlet, Verb-Noun (`Get-ChildItem -Recurse`, or `Get-Date` alone). A lone word (`santa`, `true`), a bare file name (`src/shared/owlFeatures.ts`), a capitalised phrase (`Mode | Lockdown`) and a menu path with `›` or `→` are not commands. Nor is code: a span whose first word is a JavaScript, TypeScript or Python keyword (`const`, `return`, `import`, `def`, `print` and the like), or one with a word directly followed by `(`, a call such as `fetch(url)`; a shell's `$(…)` still runs.
- Text with any control character other than newline, or a bidirectional control, is never runnable, so an escape sequence or a carriage return cannot make the shell run something other than what is shown. A tab counts: typed into an interactive shell it asks for completion, so a block indented with tabs offers no Run.
- What runs is the text the reply shows, never an attribute the model could write differently.

**5. A block runs verbatim.** Each newline becomes Enter, and one more Enter ends the last line, as if the user had typed the block. A block still being written offers Run only once its closing fence has arrived.

**6. No pass or fail per command.** After the shell starts with the command, the control shows a check and says **Run again**. It does not say whether the command succeeded: a terminal reports only its shell's exit, and the shell keeps running after the command ends. The drawer's tab keeps showing the shell's own status. Shell-integration marks could tell one command's end and exit code later; that is a follow-up, not this decision.

**7. Not on a paired host.** A paired host's thread has no drawer, so its replies offer no Run. Nor does a message shown outside a thread pane, or a user's own message.

**8. Stable shows nothing of it.** The pane asks `useOwlFeature('run-command')` before it offers Run, and main refuses `run` while the feature is off.

## Consequences

- `CONTEXT.md` names the **runnable command**.
- A reply can still describe a dangerous command, and Run makes running it one press instead of a paste. The control names the command it runs, and the press is the user's own; Sotto adds no confirmation, as a paste into the drawer has none.
- The rule will miss some commands (a capitalised program name, a lone word that is a real command) and offer Run on some code that is not a command. Missing one costs a copy and paste; a wrong offer runs only if pressed.
- Sending the feature to stable flips its entry's `sentToStable`.
