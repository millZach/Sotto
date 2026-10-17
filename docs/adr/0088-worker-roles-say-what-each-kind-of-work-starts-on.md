# Worker roles say what each kind of work starts on

## Status

Accepted by Zach on October 14, 2026, in the Watcher engine ticket map (#1023): worker roles are an Owl feature with E4 to E10 (decision 12), every role's picker offers any model from any connected provider and Computer use defaults to GPT-6 Astra (decision 13), and Settings uses variant C of the prototype at `prototype/watcher-worker-roles`, with Computer use on Full access, still capped by the new-thread default (decision 15). Built with [#1041](https://github.com/millZach/Sotto/issues/1041) (E13). It amends [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md) and [ADR-0081](0081-a-thread-may-delegate-work-to-threads-it-starts.md), and it is the Owl feature `worker-roles` ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)).

## Context

Watcher's `start_thread` and a thread's `delegate` each named a model, an effort and a permission for every start. The agent picked them, so the right model for the work was whichever one the agent thought of: Opus for a review that Zach runs on Muse, a reasoning level nobody asked for, a permission the ceiling then refused. Zach already knows what each kind of work should run on, and wanted to say it once, in Settings, with defaults that follow the providers he has connected.

## Decision

**1. Six worker roles.** A **worker role** (CONTEXT.md) is a kind of work and what it starts on: Orchestrating, which is Watcher itself, and the five kinds a start names, Building, UI, Code review, Research and Computer use. Each has a list of defaults in order, and the first whose model is ready is the one in force. With Claude Code, Codex, Muse and Grok Build connected: Orchestrating on Opus at High; Building on Opus at Extra high, then Sonnet; UI on Opus at Extra high; Code review on Muse Wonder Full at Extra high; Research on Haiku; Computer use on GPT-6 Astra. Each list goes on to the other providers' models (the prototype's orders), and a role none of whose defaults is ready takes the first ready model of a provider that can do the work, so one subscription gets its own models. Building and UI may edit without asking, Code review and Research ask first, and Computer use has Full access, because Codex's sandbox on Windows can stop Computer Use below it. Orchestrating's permission is Watcher's own mode.

**2. Only the user's choices are saved.** Settings keeps `workerRoles`, the rows the user chose, by role. A row is the user's choice once any of its three settings changes, and a row set back to exactly its default in force stops being one. A provider connecting or disconnecting never overwrites a choice: while a chosen model's provider is away, new work in that role starts on the role's default in force, and the row says so. Reset to defaults removes rows, one or all. Rows are read one at a time, so a damaged row costs only itself.

**3. Every model from every provider.** A role's model picker lists every model this computer's providers offer, so any role can use any provider the user has. Orchestrating lists them too, and a provider Watcher does not run on, Devin, keeps its tile in the menu and says why, as the composer's menu says why a provider cannot take a choice now. Watcher runs on Muse since [#1087](https://github.com/millZach/Sotto/pull/1087), so with only Muse connected Orchestrating starts on Muse's own model.

**4. Starts by role.** `start_thread` takes a `role`; `delegate` already names its kind of `work` (ADR-0081 decision 9). Main fills in what the start leaves out from the role when the start is asked, from the setting and the model catalog it already holds, and never on the update path. The ceilings stay as they are: a worker never starts wider than the user's new-thread default (ADR-0073), and a delegated thread never wider than the narrower of that and the delegating thread's own permission (ADR-0081 decision 4). A permission that comes from the role is held to the ceiling rather than refused, since the user set both; a permission the request names keeps today's refusal. Whatever the request names in its own words overrides the role for that start only, and the receipt says which settings the request named, which came from the role, and when a ceiling held a permission back, naming the limit that did: the new-thread default, or the delegating thread's own permission. A start on a paired host travels exactly as before, with the model, effort and permission filled in and no role, so no host feature is needed and an older host accepts it.

**5. Orchestrating is one choice in two places.** Its model and effort are Watcher's own, the ones its composer's chips show. Watcher's first message starts it on the role, and a change to the role in Settings replaces a pick made in that first message's composer. While a Watcher runs, a change in Settings, Reset and Reset all change it the way its composer does, the model and effort together, and another provider's model starts a new Watcher that offers the last one's handover (ADR-0073); a change in its composer saves the role for the next Watcher. Its permission is Watcher's own mode in both places, and Reset leaves it as it is.

**6. The agents are told.** Watcher's instructions and `delegate`'s description name the roles, say a start should name one and leave the rest to the user's Settings, and say that the user's words in a request override a role for that request. `read_delegation` lists what each kind of work starts on now.

**7. Stable has none of it.** With the Owl feature off, Settings shows no Watcher page, neither tool offers a role, and the saved rows are kept whole: a whole save or a reset keeps them and a change to them is refused, so turning the feature on brings them back as they were.

**8. One reader.** `src/shared/workerRoles.ts` holds the roles, their defaults and the resolution every part asks: Settings, both tools, and each provider's own sub-agents when [#1042](https://github.com/millZach/Sotto/issues/1042) (E14) has them follow the roles.

## Consequences

- The model for the work is the one the user chose for that kind of work, without the agent having to know it, and the user's words still win for one request.
- A role's model can be on a provider the user has disconnected; the row says what starts meanwhile, and nothing the user chose is lost.
- Not yet built: when Watcher's own provider disconnects, offering a new Watcher on Orchestrating's next default when the user sends. Watcher does not switch by itself; until the follow-up, the room says its provider is not connected, as today.
- Provider sub-agents do not follow the roles until E14.

## Proof

Unit tests of the reader for one, two and four connected providers, a choice through a provider disconnecting and connecting, and Reset; integration over fake providers for starts by role through `start_thread` and `delegate`, the ceiling holding a role's permission, a request's words overriding a role with the receipt saying so, and both tools without the feature; the settings repository keeping rows whole without the feature; and an end-to-end journey through Settings, under Watcher, with one delegation started by role.
