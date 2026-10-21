# Usage counts every client's work on each computer

Accepted October 14, 2026. Zach overruled ADR-0078's boundaries after the first Usage build showed almost nothing for any date range: it had begun dating work only when it was installed, left ten billion older tokens undated and outside every range, counted none of the subagents Sotto's threads started, listed one model twice, and could not read Claude's limits until a Claude turn happened to mention them. He asked for all of his usage in the selected period, and chose to count everything each computer's provider clients did, in Sotto and outside it, with Sotto's share told apart. This supersedes ADR-0078's scope, its history, prompt and model rules and its Claude-limit sentence. Everything this record does not change stands.

## What Usage counts

Usage counts the work each computer's Claude Code and Codex clients did, wherever it was sent from: Sotto's threads, the subagents those threads started, and the same clients used outside Sotto on that computer. Work **outside Sotto** is named by the app that sent it, as the provider's own records name it: Claude Code itself, the Codex app, the Codex CLI, `codex exec`, Codex in VS Code, T3 Code and the Codex plugin in Claude Code. Sotto never guesses an app from what was said.

The figures come from each client's own local records on the computer that ran the work: Claude Code's session transcripts and Codex's session rollouts, which carry each request's instant, served model and token counts. Sotto reads them on that computer, keeps the numbers, instants, model names and app names, and drops everything else in the same pass. No line, path, title or prompt is kept, logged or sent anywhere, and nothing new leaves the computer. The host reads them in the background five seconds after it starts, every five minutes and when Usage is opened, and each pass resumes where the last stopped in each file, so after the first it reads only what was added. Subagent work arrives through these passes rather than live.

A request Sotto already counted is the same request in the client's record, matched by the identity Sotto already used (Claude's message ID, Codex's turn and its running totals), so it gains its date instead of being counted again. A copy of history that a forked or subagent Codex session begins with is skipped, and repeated records count once.

Codex work Sotto started that no thread owns any more, such as a deleted thread or a side call for a title or branch name, is Sotto's work too, counted in tokens and never as a prompt. Sotto's own prompts from before Usage began come from its thread store: each stored user message, with its instant and whether it was a wake-up. Prompts outside Sotto are the clients' own user turns: a Claude Code message typed into a session, and a Codex turn, which includes each `codex exec` run. An agent can start those runs; Usage counts them as prompts and names the app, because the record cannot tell who typed them. Subagent work counts in tokens and never as a prompt.

Grok Build and Devin keep no token counts on the computer, so their work outside Sotto is not counted; their Sotto threads count as before. Work a client deleted from its own records, and Sotto threads deleted before Usage began, cannot be read back. A computer's history appears once its own Owl host carries this importer.

## Models

A prompt counts under the model that served it: the first token report after it in the same thread or session, else the model selected when it was sent. Every model is counted under one spelling, without Claude's context suffix or dated spellings, so a prompt sent on `opus` and the tokens Claude reports for `claude-opus-5-5` are one row.

## Subscription limits

Claude Code's limits are read when Usage opens and when Read again is pressed, through Claude Code's own `get_usage` request on the stream-json connection Sotto already uses: a running thread's connection when there is one, otherwise a short metadata-only process like the one that reads its model list. It sends no prompt, Sotto reads no credentials, and Claude Code talks only to its own provider, as it does for every thread. The request is marked experimental by its maker; a client without it falls back to the limits Claude Code reports during work. Window names say their length ("5 hours", "Week"). An expired window is not shown as current, and extra usage is shown only when it is turned on.

Limits are still per provider and per computer and never added together. A host from before this record does not advertise `usage-history`; the desktop then leaves out the place and window filters its stricter query would refuse, and shows that host's figures as Sotto's own work. When several computers read one provider, Subscriptions shows the freshest reading and the others as a line each.

## What stays

ADR-0078's numeric-only store on the computer that owns the work, its independence from Keep local history, thread deletion and rewind, Clear usage and its revision guard, the Owl gate, the host capability negotiation and the per-computer reading through existing host connections all stand. Clear also keeps old records out of the importer: a record from before the clear instant never returns.

## The design

The page follows the C · Focus design Zach chose for ADR-0078, rebuilt with his real numbers and checked by him on October 14, 2026. For telling Sotto's share apart he chose **3 · Where view** of three treatments: an Everywhere / In Sotto / Outside Sotto menu that every number follows, a "Where" headline, and a **Where you work** view with one bar per place, Sotto's subagents on their own bar. The prototype called the third choice Elsewhere; it reads Outside Sotto because first-run setup already uses Elsewhere for its group of other computers and the iPhone. The approved prototype embeds his real usage figures, so it is kept on his computer rather than published; the C · Focus prototype it extends stays under the `prototype/usage-dashboard` tag.

## Splitting the Per day chart

October 21, 2026. Zach asked to switch the Per day chart between bars and lines and to compare models on it. Of three prototypes he picked **C · Split the chart** over A (toggle chips under the chart, one per model) and B (comparing checked models in a chart above the Models table). The prototype is kept as the tag `prototype/usage-compare-models`.

Prompts and Tokens each get **Show** (Total, By provider, By model) and **Bars | Lines**. By provider draws every provider with activity in the range. By model draws the top five models by the stage's own measure, prompts on Prompts and input plus output tokens on Tokens, and an **Other** series for the rest, worked out per day as the total less the drawn models, never below zero, and left out when there is no rest. Bars stack, so a day stays as tall as its total and still shows who filled it; lines are never stacked, because a stacked line reads as a total and hides the series being followed. A provider has one colour wherever it is drawn, and a model keeps its colour while it stays drawn. The choice is remembered while Sotto runs and is not a setting.

The page's read carries daily totals only, so each drawn series is one more read filtered to its provider or model, the way a model's details already were, made only while a split is shown. The series colours are new: `--tt-chart-1` to `--tt-chart-6` and `--tt-chart-other`, constants per mode beside the provider marks in `tokens.css`, since a theme carries T3 Code's roles and none of them is a categorical hue. Each is at least 3:1 on every built-in theme's room and surface, and every pair, Other included, stays apart for protanopia and deuteranopia; `themeTokens.test.ts` holds both.

