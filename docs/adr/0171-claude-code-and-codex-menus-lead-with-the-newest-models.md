# Claude Code and Codex menus lead with the newest models, and retired models leave the catalog

## Status

Accepted October 31, 2026, by Zach's picks on `docs/prototypes/model-legacy-prototype.html`: variant a, **Disclosure**, for the desktop's Legacy section; no note when a moved thread's model keeps its name; and a provider that is not connected lists no models and says why. **Number provisional until merge** (docs/agents/domain.md).

Amends [ADR-0147](0147-favorite-models-lead-the-model-menu.md): a Claude Code or Codex favorite that cannot be chosen now is left out rather than listed as unavailable. Builds on #1601, which left unavailable models out of Settings › Providers' model list, and #346, which reads a long-context variant the catalog no longer lists as its base model.

## Context

The workspace merges each provider catalog over the one before and keeps every model a provider stops naming, marked not ready, so a thread on it still resolves (`acceptedModels` in `src/main/agents/workspace.ts`). Nothing ever took a model out. Every model menu listed those kept models, marked **Unavailable**, beside everything the provider offers now, oldest included.

Zach's laptop catalog on October 31, 2026 held 942 models. Claude Code's part listed Fable 5.1 three times: `fable`, which Claude Code lists now, and `claude-fable-5-1` and `claude-fable-5-1[1m]`, which it listed before it had the alias and no longer does. Both of those read "Fable 5.1", because Claude Code names a model by the first clause of its description. **Opus 5.5 with 1M context** was `opus[1m]`, which Claude Code also stopped listing; five threads were on it. Codex's kept `gpt-5.5` and `gpt-5.3-codex-spark` the same way.

So "unavailable" meant one of two things the menu could not tell apart: a model the provider has retired, or every model of a provider that is not connected now.

## Decision

**1. A model's line, and which models are legacy.** A model's **line** is its name with its version and any "with 1M context" removed, lower-cased: Opus 5.5 and Opus 4.8 are Opus, GPT-6.1-Sol and GPT-5.6-Sol are GPT Sol. A **legacy model** is one with a strictly newer model of its line in the same catalog. The provider's recommended model is never legacy, and two models of a line at the same version both lead. Only Claude Code and Codex are ordered this way; every other provider's list is left as it is.

**2. The adapter marks legacy models, once per catalog.** `markLegacyModels` (`src/shared/modelLineup.ts`) runs where the Claude Code and Codex adapters read their catalogs and sets `legacy` on the catalog's models. Every surface reads the mark from the catalog, the iPhone included, so there is one rule and nothing works it out per update. The catalog still goes to a paired phone only when it changes (#708), and it is smaller, since retired models leave it (decision 4).

**3. Menus lead with the newest, and Legacy is closed.** Every desktop model menu goes through `ModelPicker`: the composer, New thread, Continue, Watcher, worker roles and **New threads start with**. For Claude Code and Codex it lists only ready models: the newest of each line, newest first under the recommended one, then a **Legacy** row with its count, closed, that opens the legacy models in place (variant a). It is open already when the thread is on a legacy model, and a search looks through the legacy models too, under a Legacy heading. A starred legacy model stays with the newest. Settings › Providers' model list ends the same way. The iPhone's thread, New thread and Settings model menus put the legacy models in a **Legacy** submenu.

**4. A retired model leaves the catalog.** A Claude Code or Codex model the workspace kept is **retired** once that provider sends a catalog with ready models that does not name it. The workspace drops it then, unless a thread is still on it; that one stays, not ready and shown nowhere, until the thread has moved. A provider whose catalog has no ready model is not connected, and nothing of it is retired. A provider that is not connected lists no models in the menu and says: "Claude Code is not connected. Connect it in Settings › Providers to choose a model."

**5. What was on a retired model moves to its successor.** A retired model's **successor** is, for a long-context variant whose base is ready, the base (`opus[1m]` becomes `opus`, Opus 5.5); otherwise the newest ready model of its line; otherwise the provider's recommended model; otherwise the first it lists. A model the catalog no longer holds is placed in a line by its ID (`servedModelName`).

- **A thread** moves when it is opened, by the same `configure-thread` a press in its composer sends. Moving a Claude Code thread restarts its client, and opening a thread starts it anyway, so threads nobody opens start nothing. A thread that is settled, archived, working or waiting on the user is left until it is next opened as it may be. A thread opened before its provider's catalog arrived moves when the catalog does. Where the two names differ, the thread keeps `modelMoved` and its transcript shows one line after the last turn begun before the move, on the desktop and the iPhone: "Claude Code no longer offers Opus 5.5 with 1M context, so this thread now uses Opus 5.5." Where they are the same, as `claude-fable-5-1` becoming `fable`, both Fable 5.1, it moves without a line.
- **A setting**, such as **New threads start with** or a worker role, is read through `modelInForce`: it runs on and shows the successor, and the next save stores it. Main does not rewrite settings files on its own. A saved ID the catalog holds no entry for may be a model the user named rather than a retired one, so it moves only to a ready model of its own line, never to the provider's default.

A long-context variant the catalog never listed, which #346 reads as its base, is not retired: it resolves to a ready model and keeps running as it is.

## Consequences

- Menus are short again: Claude Code shows Default and the newest Opus, Sonnet, Haiku and Fable, and Codex the newest of each GPT line, with Legacy behind one press.
- A thread on a model the catalog never held, which only a typed ID could reach and no surface offers, is not moved.
- A remote host on an older Sotto sends no `legacy` marks, so its models all lead until it is updated.
- The rule reads names. A provider that renames a line, or puts a version where Sotto does not look for one, can lead with an older model; `tests/unit/shared/modelLineup.test.ts` pins the names Claude Code and Codex use on October 31, 2026.
