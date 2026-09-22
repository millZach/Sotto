# A Devin permission mode is an owned profile, not a provider mode

Accepted September 22, 2026 following Zach's explicit decision. Devin threads offered one permission
setting, "Ask for approval", because the Sotto-owned profile pinned by ADR-0017 asks before every edit,
command and fetch. Zach asked for the rest of Devin's modes. This records what the modes turned out to
mean and how Sotto offers them without any of them lying.

Devin reports five conversation modes at `session/new`: Code (`accept-edits`), Smart, Ask, Plan and
Bypass Permissions. A compatibility run against CLI 3000.10.31 shows the mode does not decide whether
Sotto is asked. Under the pinned ask profile both `accept-edits` and `bypass` still sent
`session/request_permission` for a shell command; under a profile allowing `exec`, the same request under
`accept-edits` sent none. The profile decides; the mode does not. The evidence is in
[the mode experiment](../verification/devin-permission-modes.md).

So a Devin permission setting is an owned profile with an allowance, and the conversation mode travels with
it rather than standing for it. Three allowances exist: `nothing` asks about every edit, command and fetch;
`edits` allows edits and writes and asks about every command and fetch; `everything` allows all of them.
Each allowance is a separate versioned file under the Sotto data folder, written and read back before a
thread runs under it, exactly as the single profile already was, and the allowance travels with the path so
a profile is never checked as a different one. The `nothing` allowance keeps the original file name, so a
profile written before allowances existed is still the one an asking thread uses.

The chip offers the modes Devin reports, under Devin's own names, each with its allowance, and one setting
of Sotto's own — "Ask first", Devin coding while Sotto asks about everything. That extra entry is the default
and the one every existing thread keeps. It exists because none of Devin's five means "code, but ask me",
and an upgrade may not let Devin act unasked where the user never chose it (ADR-0004). Every entry carries one
sentence saying what Sotto will still ask about under it, so a mode called Bypass Permissions cannot be
read as Sotto having stopped asking when it has not. Ask and Plan take the `nothing` allowance because
neither claims to act; Code and Smart take `edits`, which is what "write and edit code" says and no more,
leaving Devin's own judgement as the only thing Smart adds; Bypass takes `everything`. A mode Devin does not
report is not offered, and a mode Devin reports that this table does not know is not offered either, because
Sotto cannot say what it allows.

An allowance is written into a profile, and a profile is chosen when the Devin process starts, so changing
a thread's mode writes and confirms the new profile, records it, stops that thread's session and resumes it
under the new profile on the next action. The native session is untouched by the stop; the recorded mode is
what every opened session is set back to, a session that will not confirm its mode is refused rather than
run under a setting the user did not choose, and a mode change is refused while the thread is opening,
sending or running, so the recorded mode and the running profile cannot come apart.

This is the same kind of choice ADR-0004 already records for Codex, Claude and Grok: a thread's permission
mode is the user's own setting, and a mode that lets the provider act unasked means the request never reaches
Sotto. The owned profile is not an ADR-0004 policy record and grants no authority of its own; it is how the
user's choice is carried out for a provider whose modes do not say what they allow. ADR-0004's consequence
and ADR-0017 are amended to say so. This does not change what Sotto logs, the hosts it contacts, or the
pinned CLI version, and it does not make a mode's native meaning Sotto's business: Sotto states what it will
ask about, which is the part it can keep.
