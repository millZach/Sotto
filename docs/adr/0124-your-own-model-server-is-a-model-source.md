# Your own model server is a model source

## Status

Accepted October 23, 2026, as an Owl feature (`own-model-servers`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It amends [ADR-0087](0087-opencode-is-a-thread-provider.md): OpenCode runs model sources Sotto declares as well as ones it signs in to. **Number provisional until merge** (docs/agents/domain.md).

Zach asked for local inference for anyone who runs a model: "use whatever model he has or anyone has on their local machines... use Sotto to drive that machine through whatever harness we want... a thread or watcher could even use that model." It began as four DGX Sparks at his brother's house serving DeepSeek V4.1 Flash with SGLang. He chose the general shape on October 23 from a question card and from [the prototype](https://github.com/millZach/Sotto/blob/prototype/local-model-server/docs/prototypes/local-model-server-prototype.html) (layout B, with C's model menu entry). [The plan](../plans/local-inference.md) holds the phases and what OpenCode 2 was checked to do.

## Context

Amendment, November 9, 2026: Hermes (Owl) also runs servers added with a key.
Add hands the key to Sotto's Hermes after Sotto's OpenCode has taken it, so a
keyed add still needs OpenCode running and OpenCode stays the first keeper.
Hermes keeps its copy in `own-server-keys.json` in Sotto's Hermes folder (mode
600) and writes it to each Hermes profile's `.env`; the generated config names it
only through `key_env`. Remove deletes Hermes's copy, from its record and from
the `.env` of the root and every profile at once, before OpenCode signs out.
A server keyed before this is offered on OpenCode alone until it is added again.

People run models on their own machines with SGLang, vLLM, Ollama, LM Studio, llama.cpp and similar servers, nearly all of which answer the OpenAI API. Sotto drives native clients, and the one that can already run any OpenAI-compatible model is OpenCode 2 ([ADR-0087](0087-opencode-is-a-thread-provider.md)), whose live test already runs a thread against a local server declared in its config. What Sotto lacked was a way to declare one: OpenCode lists models only from its catalog, the sign-ins in Sotto's OpenCode folder and its config, and never asks a custom server what models it has.

What the user calls a harness is, in Sotto's words, the **provider**. The server is a **model source**, as Anthropic or OpenRouter are under OpenCode.

## Decision

1. **A server is a model source, kept apart from any one provider.** Settings › Providers gains **Your own model servers**, a group above the provider tiles: a row per server with its address and models, **Check again** and **Remove**, and **Add a server**. OpenCode's source list in the thread model menu ends with **Your own server…**, which opens the same dialog. OpenCode is the first provider to run them; Codex follows for servers that speak the Responses API, and **Run it with** appears in the dialog only once there is a second provider to choose.
2. **Sotto keeps the record and declares the server to OpenCode.** Main saves each server's name, address and models (context, output, thinking, images) in `own-model-servers.json` under Sotto's user data. Every OpenCode process Sotto starts is given one provider block per server in `OPENCODE_CONFIG_CONTENT`, with OpenCode's OpenAI-compatible package, so nothing is written into Sotto's OpenCode folder and the record is the one truth. Each model declares its reasoning and its input, since OpenCode otherwise gives an undeclared model low, medium and high effort and image input. A change makes OpenCode's processes outdated, as a sign-in does.
3. **OpenCode keeps the key.** A key is optional. One given goes from the dialog to main once and from main to Sotto's OpenCode once, through the same `connect/key` sign-in every model source uses, and Sotto keeps no copy. One key per server: who gets it is up to whoever runs the server.
4. **Plain http only to a private address.** This computer, a home or office network, and the tailnet (100.64.0.0/10, `*.ts.net`) may use http; a public address needs https, so a key and code never cross the internet unencrypted. Sotto never sets up Tailscale Funnel ([ADR-0088](0088-sotto-leans-on-tailscale.md)).
5. **Sotto itself contacts the server only when the user presses Check, Add or Check again.** It reads the model list and what the server says about each model's context and abilities: `max_model_len` from vLLM and SGLang, Ollama's `/api/show`, LM Studio's `/api/v1/models`, llama.cpp's `/props`, TGI's `/info`. A context the server does not report is typed by the user. Nothing runs in the background, so a row shows only what the last check said. During threads only OpenCode talks to the server.
6. **Thinking is on where the server says the model can think**, at the model's default effort, and side calls take the least ([ADR-0026](0026-short-writing-runs-on-the-threads-own-provider.md)). The user can turn it off per model when adding.
7. **A server that goes away fails the turn plainly.** The thread says what happened, that nothing in it was lost, and to check the server, with Try again. Nothing moves to another model on its own, so code never goes where the user did not choose.
8. **The add dialog says once who can read what is sent:** threads on this server send your code and messages to it, so whoever runs it can read them.
9. **Off, nothing of it runs.** With the Owl feature off, main registers no channel, OpenCode is given no server, and Settings and the model menu show none. The saved record stays, so turning the feature on restores it.

Watcher on a server's model, hosts adding their own servers and Codex as a second provider are later phases of the plan and will amend this record. Watcher will run only on a model that passes a readiness check: a working tool call, at least 128K of context and at least 30 tokens a second, a model that fails being shown in Watcher's model menu with the reason and not offered. AI cleanup on a user's server is out of scope; it would supersede part of [ADR-0069](0069-one-model-does-ai-cleanup.md).

## Consequences

A new kind of host appears in the README's privacy section: an address the user typed, contacted by Sotto on a press and by OpenCode during that user's threads.

Sotto does not vouch for a server's model. Tool calls, long prompts and reasoning replay depend on the server and the model, and a model that cannot call tools well will fail threads in ways Sotto can only report.

Every word the group, the dialog and the model menu entry say is a message in the interface language ([ADR-0123](0123-sottos-interface-speaks-the-computers-language.md)). Main still answers a refusal in English beside its reason, because `src/shared` is built into the headless host without the macro transform, and the window words each reason itself; main's English shows only for a reason a window does not know.

OpenCode keeps a server's key in its database in Sotto's OpenCode folder, in the clear, as it keeps every model source's key. Remove signs the source out there.

Checking OpenCode for this found that it reads `opencode.json`, `.opencode`, `.claude` and `.agents` from every folder above a thread's project, and lists `~/.opencode` as a config source, so ADR-0087's "the user's own OpenCode folders are never read" holds only for its XDG folders. That is #1425; this decision neither causes nor fixes it.

## Amended October 24, 2026: when the server lets a turn down

Zach chose how a thread on one of his own servers says the server let a turn down, from [the prototype](https://github.com/millZach/Sotto/blob/prototype/own-server-turn-errors/docs/prototypes/own-server-turn-errors-prototype.html) (placement A, the words as drafted). It replaces OpenCode's general "could not finish this turn" and its advice to sign in again, which do not fit a server the user runs. It is part of the same Owl feature.

- **In the transcript.** The lines below sit where the reply would be, under the user's message, and a failure is the turn's own "Failed after …" line with its reason and buttons, so it stays in the thread where it happened. Only the newest failure keeps its buttons.
- **While OpenCode tries again.** OpenCode tries a server that does not answer ten times over about a minute and a half. Meanwhile the turn's line reads "Sparks isn't answering. Trying again (3 of 10)." with **Stop**, and gives way to the reply if the server comes back.
- **While it waits.** A server that took the message and has sent nothing for 30 seconds: "Still waiting for Sparks to start answering. A long prompt can take a few minutes. The turn stops waiting at 5 minutes." with **Stop**. OpenCode's own 300-second limit stays, because a long prompt on a large model can take minutes before its first word. OpenCode would try a silent server three more times after it, about twenty minutes in all, so Sotto stops the turn at the first and records it as the server's timeout, which keeps the words true.
- **Five failures,** each saying what happened, that nothing in the thread was lost, and what to do, with **Try again**, which sends the user's last message again: the server did not answer after its tries, naming its address to check; it did not start answering within five minutes; it turned down its key, with **Open Settings** at Your own model servers first; it no longer has the model; the thread is longer than the model takes, where the next step is a model with more context or a new thread, since OpenCode threads are not compacted in Sotto.
- **Nothing moves elsewhere on its own,** as decided above: Try again goes to the same server.
- **Removed and added again, the same server.** A server's ID comes from its address, so one removed and added again with the right key is the same model source and the thread's model is valid again. An address already added is refused, since it would be a second source for the same server.

## Amended October 25, 2026: a server can clean up dictation

[ADR-0136](0136-ai-cleanup-can-run-on-your-own-model-server.md) puts AI cleanup on a user's server in scope, as its own Owl feature (`own-server-cleanup`), replacing the line above that left it out. A model on a server added without a key can be the cleanup model, and it amends decision 5: Sotto itself also contacts such a server when the user chooses one of its models for cleanup or presses **Measure again**, and with each dictation AI cleanup runs on while that model is chosen. During threads only OpenCode still talks to it.

## Amended November 1, 2026: the server mark

Drake chose how a thread on one of the user's own servers shows what its server is doing, in two rounds on November 1, 2026. From [the first prototype](../prototypes/spark-cluster-mark-prototype.html) he kept the mark's states (panel 2) and the speed card (panel 4), with the mark only where those need it, in the model chip and on the running turn's live line. Not wanted, though that prototype showed them: the mark on the sidebar row (panel 1), a spark when the first word comes (panel 3), an accent line along the composer (panel 5) and the mark in the floating widget while cleanup runs on a server (panel 6). [The refined prototype](../prototypes/spark-cluster-mark-refined-prototype.html) replaced the first one's animations, and from it he picked **A, Trail** for how writing moves (not B, a meter that fills like signal bars) and **B, Figures + graph** for the card (not A, figures alone). In two polish rounds he then had the mark made brighter (larger cells, a muted rather than faded rest), the trail made a comet (the head lights at once and only the two cells behind it fade, one step at most every 90 ms), the card lead with its speed as a large figure over a graph of fixed slots that scrolls, and the speed given in **tokens a second** rather than words, since that is how local model speed is measured ([the polished prototype](../prototypes/spark-cluster-mark-polished-prototype.html); he checked it rendered in his own composer). Neither provider counts tokens while a reply streams, so he chose the estimate, then the exact count: the live figure is estimated from the text at about four characters a token and says “about”; on OpenCode, the server's own count of the tokens it wrote, reported as each step ends, replaces it with that step's exact rate, and a turn the window saw from its start averages on that count. DeepSeek Harness counts no tokens, so its figures stay estimates. It is part of the same Owl feature, and off it nothing changes.

- **The server mark.** Four square pixels in a 2x2 grid, with no rounding. In the thread's model chip it sits beside the provider's mark, which stays so a thread is never mistaken for another provider's (ADR-0138); on the running turn's live line it stands where the pulse would, a size larger. One glyph for any server: it does not count the server's machines. The chip knows a thread is on its own server from its model ID, which starts with the server's ID for OpenCode and DeepSeek Harness alike; the live line from the turn's own-server record, which also words its lines.
- **What the cells do.** Each state differs by shape and motion as well as colour, and the motion while writing comes from the server, not a timer. Idle: all four dim and still. Reading the prompt (the turn runs and nothing has come yet): one lit cell steps clockwise about every 420ms; it implies no progress, since the server reports none. Writing: each text update that arrives moves the lit cell one step clockwise, the cell before it drops to half and the rest go off, with a 260ms fade, at most once a frame; with no update for 700ms the lit cell fades to half, so a stall visibly stops it. Not answering (OpenCode is trying the server again, or the last turn ended because the server never answered): hollow cells, an outline with no fill, blinking once for each new try. Hollow rather than grey, so it reads apart from idle without its colour. Done: all four light once as the turn ends with its reply, then settle to idle over half a second. On the live line the words stay as they were ("Still waiting…", "Trying again (3 of 10)"), and unlike the pulse the mark stays beside the working words while their light crosses them, since it is the only place the line shows the server reading or writing. Under reduced motion each state holds still: one lit cell while reading, all four while writing, hollow with no blink while not answering, and no flash when done.
- **The speed card** opens upward from the chip after the pointer rests on it for 300ms, or at once when the keyboard brings focus to it, in place of the chip's tooltip. Escape closes it, from the chip or wherever the focus is while the pointer rests on the chip, and leaves the focus where it was; opening the model menu closes it, and the pointer passes through it, so it never covers the menu or stops the chip opening it. It keeps the chip's full name at its top, so the card still names the model. Under it a header says "This turn" while the turn runs, "Last turn" once it has ended, or "Last turn didn’t start" when the server never answered, with the server's host and port on the right. Then a speed graph of the turn: a bar for each quarter second, as tall as the words per second in it, with a dash for each quarter second of the wait before the first word, the last 56 kept. Then the figures: **First word after** (counting up as "Waiting, 42s" before it comes, "No answer" when the server never answered), **Words per second** (the words of the last second and a half, "Paused" in a fainter ink when none came, "38 average" once the turn has ended) and **Context used** ("183k of 256k", over a bar of 16 segments). After a turn ends the card keeps its figures until the next turn starts, and before a thread's first turn there is no card. While the card shows a running turn it counts on four times a second; hidden, it does not.
- **What the figures are.** The graph, the first word and the words per second are what this window saw of the turn, kept in memory until the window closes, rather than anything a record carries: OpenCode stamps a reply with the time its step began, before the server sent anything, so no record says when the first word came, and adding that time to both adapters' turn records was more than this needed. So a window that did not see the wait (opened part-way through a turn, or reloaded) has no first-word time and no dashes, the text it finds already written is where it starts counting, and a retry after the first word is no wait for it. Words per second show once text has come in pieces less than 1.5 seconds apart, so a reply that lands whole shows none, and the average leaves out gaps longer than that, a tool running. Context used is the thread's usage, as the compaction offer reads it, so it shows only for a provider that says how full its context is: DeepSeek Harness does, OpenCode does not (its profile's `reportsContext` is false), so OpenCode threads have no Context used row. Giving them one would mean reading the context from OpenCode's token counts in main and the model's size from the saved server, which was more plumbing than this needed. The bar shows only when the usage also says the window's size.

The mark is drawn in the renderer from what it already has; main, its update path and the turn records are unchanged.

## Amended November 10, 2026: Hermes's official installer

Hermes's official installer keeps Python packages per Hermes data root. Sotto's
separate Hermes folder can therefore have no packages even though the installed
Hermes works in the user's terminal. When the version check reports that missing
environment, Sotto explains it and gives a `hermes pm repair` command with
`HERMES_HOME` set to Sotto's folder. It says the command downloads Python packages
and asks the user to connect again afterwards. Other version failures ask the user
to check Hermes in a terminal, without prescribing a reinstall.

Sotto does not run the repair itself: connecting a provider does not silently
download packages. The user's own Hermes home and dependency environment stay
separate. This also covers a missing environment after an update, should Hermes
require it again; that update case has not been observed.

For gateway readiness and profile rescans, a venv install keeps using the Python
beside its executable. With no adjacent Python, Sotto uses the published
`hermes --run-module` interface and Python's standard-library `timeit` module,
with one execution and one repeat, to run each helper statement once. The
launcher selects its own interpreter and activates its packages. Sotto does not
parse shell wrappers, modify bootstrap code, copy a dependency environment, or
guess a store path. A failed helper still fails the operation. Readiness only
discovers the gateway Sotto started; it never starts a second owner.

Only a folder with that adjacent Python is removed from the toolchain PATH.
An official launcher in a shared folder such as `~/.local/bin` keeps that folder
and its other tools available. [The verification note](../verification/2026-11-10-hermes-official-install.md)
records the native check and the in-app check still owed.


## Amended November 10, 2026: Hermes can keep the key alone

A keyed server can be added while Sotto's OpenCode is connected or Hermes's
adapter runs. This replaces the November 9 requirement that OpenCode take the
key first. When OpenCode is connected it still takes the key first, and Hermes
gets its copy when available. Otherwise Hermes takes the key alone. The adapter
need not be connected yet: saving a first server lets Hermes connect to it.

The server record has an optional `keyKeeper`, `opencode` or `hermes`, naming the
provider that first took the key, never the key itself. An older keyed record
without that field means OpenCode. A Hermes-only keyed server is left out of
OpenCode's generated model sources, including when OpenCode connects later.
There is no automatic key transfer; remove and add it again with OpenCode
connected to use it there. This amends decisions 2 and 3.

Remove asks OpenCode to sign out only for a key it took, and clears Hermes's key
file and every profile copy even while its adapter is off. Only then does the
server leave the record. A failed add clears a possibly saved key before rolling
back its record too; if cleanup or the record write fails, the server stays
listed for Remove to finish. An unreadable key store or profile is a failed
cleanup, not proof that no key remains. Failed temporary key writes are cleared
too. This replaces the old rollback that could forget a server after an
unconfirmed OpenCode sign-out.

Check again still sends no saved key. If the server asks for one, the row says
it answered but its models could not be read again. The dialog and rows make no
promise that OpenCode can run every server. No host, setting, dependency or
permission rule changes.


## Amended November 10, 2026: add an API with its key

The owner approved layout A after four polish rounds, at local prototype commit
`47b4e2a79`. [The approved mock-up](../../design/add-an-api/index.html) and its two
JSON samples travel with this change; its hundreds of captures do not. This
amendment supersedes the original dialog, discovery and thinking decisions above.
It remains behind `own-model-servers` and `hermes`; stable starts and shows none.

Settings > Providers has **APIs and your own model servers**, with one Add dialog.
Main downloads `https://models.dev/api.json` when the dialog opens, or on Check
again for a saved https address so a record older than the catalogue gets its
facts, without a key,
cookies or user data. It reads a bounded response, caches it in memory for this
app run, never logs it and never writes it to disk. Failure leaves Another address
available and offers a retry. Only catalogue entries with an `api` address and
`@ai-sdk/openai-compatible` (plus OpenRouter) are listed. There is no separate
address list for OpenAI, Anthropic, Google or xAI; search explains the compatible
address route and existing thread providers in plain words.

The selected API's own model answer supplies its inventory. Its facts win field
by field over the catalogue: display name, context, longest answer, image input,
tools and prices. Prices from the API are per token and become per million;
catalogue prices already use per million. Unknown stays unknown. Exact IDs are
kept. Nothing is typed except a genuinely missing context needed to run a model.
Only confirmed thinking levels are offered, with Off first when a toggle or a
`none` value permits it. Otherwise a thinking model uses **Default**, without a
slider. Old `thinking: true` records retain OpenCode Low, Medium and High until
checked again; reading an old record changes nothing on disk.

**Kept models** are the chosen IDs, separate from the saved inventory. Ten or
fewer discovered models start all ticked; more than ten start unticked. Search and
All / Selected / New appear only above ten. A recheck keeps choices, leaves new
models unticked, and retains older models for existing threads. Unticking removes
a model from new picks only; threads already on it continue to work.

**Replace key** checks the new key before asking the existing keeper to replace
it and preserves the model choices. A refused key never reaches the keeper, so
the old key remains. The first keeper remains OpenCode when connected, otherwise
Hermes, including keys already saved under the November 9 rules. No key enters
Sotto's model-server record, logs, errors, command arguments or fixtures.

Hermes sets effort per session through `session/set_config_option` with id
`reasoning_effort`, maps Off to `none` and Default to `default`, and reads the
answer's config options back. The option is in Hermes 0.22.6 (source commit `b2f9dee01a`), below Sotto’s
verified 0.23.0. The session’s advertised options remain authoritative. Older
Hermes without that option offers no effort
control and continues turns normally. OpenCode gets each model's confirmed list.
The real effort card stays; Default has no stops. A model without Off says it
always thinks, and changing models chooses the nearest supported effort, lower
on a tie. This supplements ADR-0087's model-variant rules.

The build fixes two prototype mistakes: the four-model list has no search or
filters, and compact rows let more than two models fit at 820 by 560. The provider
answer wins for prices and both limits even when the catalogue disagrees.


OpenRouter's model list is public, so its key is checked first through its
[current-key route](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
(`GET /api/v1/key` at the chosen OpenRouter address). The answer is discarded;
no inference is sent, and an unauthenticated key never reaches either keeper.
Other APIs are checked through their own model-list authentication.


### Review corrections: large catalogues and existing choices

OpenCode's model declarations go in a generated JSON file for each process under
Sotto's own OpenCode config folder, named with Sotto's PID and a random suffix.
`OPENCODE_CONFIG` carries only that path; `OPENCODE_CONFIG_CONTENT` keeps the small
share/update settings and source routing overrides, so project config cannot
redirect a saved source or its key. This supersedes the original environment-only declaration:
a large API can exceed Windows' 32,767-character per-variable limit. The file has
no actual key, is removed when its process closes, and files left by a dead Sotto
are removed on a later start. The saved model-server record remains the source of
truth. Kept and existing-thread models still retain their declarations.

An initial or Default effort never selects Off. Toggle-only models reset to
Default unless Off was explicitly chosen. Known numeric lists prefer Medium,
then High, then their first thinking level. Old OpenCode thinking flags survive
Choose models unchanged until a recheck. Hermes no longer pins every new session
to High: an unset choice uses Default, as the owner approved; protocol replay
cannot overwrite a newer user choice. A transient effort-request error is not
evidence that the installed client lacks effort support.

Catalogue addresses with account or region placeholders open the address route,
with the template visible and editable. No request is sent until those values
are supplied. The key page shows the actual address that will receive its key.
