# Devin permission modes: what the mode decides and what the profile decides

September 22, 2026, Windows 11, Devin CLI 3000.10.31 (the pinned version), against Zach's own Devin
account with his authorization to spend a small amount of credit. Each run used a fresh empty temporary
working folder, a profile written for that run alone, and a single short prompt. Permission requests were
refused, so nothing the agent asked for was carried out.

## What Devin offers

`session/new` returns `modes.availableModes` and a `mode` entry in `configOptions`: `accept-edits` (Code,
"Write and edit code"), `smart` ("Auto-approve actions the model judges safe"), `ask` ("Answer questions
without code changes"), `plan` ("Plan changes before implementing") and `bypass` ("Auto-approve all tool
calls"). A session opens on `accept-edits`. `session/set_config_option` with `configId: 'mode'` sets the
mode and echoes the new value back in `configOptions`, which is how the adapter confirms it.

## The mode does not decide whether Sotto is asked

Prompt: run the shell command `echo sotto-mode-probe`. Profile: the pinned ask profile from ADR-0017.

| Devin mode | `session/request_permission` received |
| --- | --- |
| `accept-edits` | 1 |
| `bypass` | 1 |

Bypass Permissions did not bypass Sotto. This is the finding the feature rests on: a Devin mode says what
Devin will not ask *itself* about, and says nothing about what reaches Sotto.

## The profile does

Same prompt, same `accept-edits` mode, a profile granting `exec`: **0** permission requests. Changing only
the profile changed the outcome.

## The settings as shipped

One run per setting, each under the profile that setting now writes, with the mode echoed back confirming
it was set. Two prompts: one that runs a shell command, one that creates a file.

| Setting | Devin mode | Grant | Command asked | Edit asked |
| --- | --- | --- | --- | --- |
| Ask first | `accept-edits` | `nothing` | yes | yes |
| Code | `accept-edits` | `edits` | yes | no |
| Bypass permissions | `bypass` | `everything` | no | not run |

Every row matches what the chip says about that setting. Smart shares the `edits` grant with Code and was
not run separately; Ask and Plan share the `nothing` grant with Ask first and were not run separately,
because the grant is what the table is testing and Devin's own behaviour within a grant is its own.

## Not checked

The `everything` grant was exercised for a command, not for an edit or a fetch. Mode changes on a thread
with existing history were exercised through the adapter's own tests rather than against the live CLI, so
the live resume-under-a-new-profile path is covered by unit and integration tests only. macOS is
unverified, as ADR-0017 already records.
