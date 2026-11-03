# A permission card shows readable words, not a tool's raw input

## Status

Accepted November 2, 2026, by Zach's picks from `docs/prototypes/permission-summary-prototype.html`: the "says" line, a plain line for settings beyond the command, and the same cleanup for every other request.

## Context

A permission card showed the command and then the tool's whole input as raw JSON, with the command again, its `\n` escapes and all. Zach asked for it to go, and for one or two sentences on what the command does, from the model that asks.

Asking another model to summarize would add a wait, a cost and a new place a command goes. Most providers already send words of their own: Claude's `description`, Grok Build's `description`, DeepSeek Harness's `description` and `justification`, and Codex's optional `reason`. Claude's frame also has a `description` beside the input, but it holds a stock line such as "Run shell command" when the model wrote none, so it isn't the model's words.

The raw box was doing two other jobs. It was the only place some settings showed, such as Claude's request to run outside the sandbox, and it was the only place a file edit's change showed.

## Decision

**A command summary is the model's words, marked as its own.** `context.summary` carries what the provider sent, on one line and bounded. The card shows it under a line such as **Claude Code says**, then the command. It is never the headline, and the command stays what the user answers.

**Sotto generates nothing.** A command that came with no summary says so and shows the command. No command goes to another model for this. (Replaced by the amendment below.)

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

## Amendment: Sotto asks when the model sends none (November 2, 2026)

Zach asked that a user always gets a summary, reversing **Sotto generates nothing** above, by his picks from `docs/prototypes/asked-command-summary-prototype.html`.

**Sotto asks the thread's own provider.** When a command's model sent no summary, the coordinator makes a side call (ADR-0026) to that thread's provider, with the command as its only material. It adds no host and no key, and the command goes only to the provider that proposed it. The side call sees no thread, so it can say what a command does but not why the thread wants it. A crafted command could mislead it, and the instruction tells it to treat the command as something to describe. It runs no tools, as every side call does, and Watcher's own thread may make it, as it may a next-prompt one. Nothing it sends approves anything, and the command stays what the user answers (ADR-0004).

**The card says so.** `context.summaryAsk` carries `waiting`, `answered` or `failed`. An answer shows under **Sotto asked Codex what this does**, apart from the model's own **Codex says**.

**The card never waits.** Allow and Deny work from the start while it reads **Asking Codex for a summary…**. Answering a request, or its thread going, stops its call. The outcome is taken like a new snapshot, because a thread waiting on a permission may send no other. Two run at once and the rest wait their turn, since a client starts cold for each.

**"Always" has limits.** No other provider is asked in a thread's place, as ADR-0026 says, so a side call that fails says **Codex couldn't give a summary of this command.** Devin, DeepSeek Harness and Muse have no side call, and without their own summary they say **gave no summary**. A command too long to send whole, over 20,000 characters, gets no summary rather than one of its opening. Sending a command to another provider would be a new place it goes, and that is an ADR and a README change of its own.

**Off with a switch.** **Generated command summaries**, on by default, sits with Generated thread titles, and each computer reads its own. Unlike titles it does not need Keep local history: the asks live in memory alone, and Sotto keeps nothing about a command.

**A cost:** each ask comes out of the thread's subscription at the lowest effort, and may take 10 to 20 seconds. It goes straight to stable.
