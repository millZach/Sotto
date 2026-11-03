# A permission card shows readable words, not a tool's raw input

## Status

Accepted November 2, 2026, by Zach's picks from `docs/prototypes/permission-summary-prototype.html`: the "says" line, a plain line for settings beyond the command, and the same cleanup for every other request.

## Context

A permission card showed the command and then the tool's whole input as raw JSON, with the command again, its `\n` escapes and all. Zach asked for it to go, and for one or two sentences on what the command does, from the model that asks.

Asking another model to summarize would add a wait, a cost and a new place a command goes. Most providers already send words of their own: Claude's `description`, Grok Build's `description`, DeepSeek Harness's `description` and `justification`, and Codex's optional `reason`. Claude's frame also has a `description` beside the input, but it holds a stock line such as "Run shell command" when the model wrote none, so it isn't the model's words.

The raw box was doing two other jobs. It was the only place some settings showed, such as Claude's request to run outside the sandbox, and it was the only place a file edit's change showed.

## Decision

**A command summary is the model's words, marked as its own.** `context.summary` carries what the provider sent, on one line and bounded. The card shows it under a line such as **Claude Code says**, then the command. It is never the headline, and the command stays what the user answers. The iPhone's sheet leads with the request (#1855), so a command's headline there is Sotto's own **Claude Code wants to run a command** and never the first line of the request's text, which can hold the summary. Any other request leads with its action.

**Sotto generates nothing.** A command that came with no summary says so and shows the command. No command goes to another model for this.

**No raw input on a permission card.** An adapter turns a tool's input into readable text in `src/main/agents/requestInput.ts`:

- A command shows its command and summary, with its folder where it sent one, and leaves out only its timeout. Any other field shows in a plain line, with the settings Sotto has words for said in words. Those lines are `context.details` beside `context.command`, and the clients show them as prose.
- Any other request says what it does (`context.action`) and on what (`context.target`), then shows its changed lines and every other field by name in `context.details`, and the clients show them on the code surface. Nothing is dropped, and input too long to fit says it was cut. Only commands get the "no summary" line.

**The record of the answer keeps its own evidence.** Devin's `actionDetails` and Claude's `updatedInput` still hold the exact input, so what a press allows does not change. The risk check reads the card's words and the command together, because the request's text no longer repeats the input.

**A protocol method's name is no tag.** Codex's `item/commandExecution/requestApproval` no longer shows beside a card's heading on the desktop.

## Consequences

- An older computer still sends raw input. A phone or desktop connected to it shows that until it updates, because the alternative is to hide settings such as running outside the sandbox.
- An older phone connected to a new computer shows readable text, without the summary. So does the Android app, which this decision does not change.
- Cursor sends no summary. OpenCode sends none on a permission, though its tool call may hold one; reading it means joining the two, and it wasn't checked against a real OpenCode.
- The words an adapter writes, such as **Edit a file** and **It also asks to run outside the sandbox.**, stay English in every interface language, as adapters' words already do. Adapters also run in the headless host, which sets no language, so a translation call there would throw and lose the request. Translating them means the clients translating from a stable key. **Run a command**, **says** and **gave no summary** are written by the clients, so they are translated.
- Which summaries show depends on what each provider chooses to send, and Codex's `reason` often isn't there.
