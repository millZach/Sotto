# A Devin permission mode is an owned profile, not a provider mode

Accepted September 22, 2026 following Zach's explicit decision. Devin threads offered one permission
setting, "Ask for approval", because the Sotto-owned profile pinned by ADR-0017 asks before every edit,
command and fetch. Zach asked for the rest of Devin's modes. This records what the modes turned out to
mean and how Sotto offers them without any of them lying.

Devin reports five conversation modes at `session/new`: Code (`accept-edits`), Smart, Ask, Plan and
Bypass Permissions. A compatibility run against CLI 3000.10.31 shows the mode does not decide whether
Sotto is asked. Under the pinned ask profile both `accept-edits` and `bypass` still sent
`session/request_permission` for a shell command; under a profile granting `exec`, the same request under
`accept-edits` sent none. The profile decides; the mode does not. The evidence is in
[the mode experiment](../verification/devin-permission-modes.md).

So a Devin permission setting is an owned profile with a grant, and the conversation mode travels with it
rather than standing for it. Three grants exist: `nothing` asks about every edit, command and fetch;
`edits` allows edits and writes and asks about every command and fetch; `everything` allows all of them.
Each grant is a separate versioned file under the Sotto data folder, written and read back before a thread
runs under it, exactly as the single profile already was. The `nothing` grant keeps the original file name,
so a profile written before grants existed is still the one an asking thread uses.

The chip offers Devin's five modes under Devin's own names, each with its grant, and one setting of
Sotto's own — "Ask first", Devin coding while Sotto asks about everything. That extra entry is the default
and the one every existing thread keeps. It exists because none of Devin's five means "code, but ask me",
and an upgrade may not hand Devin a permission the user never granted (ADR-0004). Every entry carries one
sentence saying what Sotto will still ask about under it, so a mode called Bypass Permissions cannot be
read as Sotto having stopped asking when it has not. Ask and Plan take the `nothing` grant because neither
claims to act; Code and Smart take `edits`, which is what "write and edit code" says and no more, leaving
Devin's own judgement as the only thing Smart adds; Bypass takes `everything`.

A grant is written into a profile, and a profile is chosen when the Devin process starts, so changing a
thread's mode writes and confirms the new profile, records it, stops that thread's session and resumes it
under the new profile. The native session is untouched by the stop; the recorded mode is what a resumed
session is set back to, and a session that will not confirm its mode is refused rather than run under a
setting the user did not choose.

This does not relax ADR-0004. Authority still lives only in a policy record; what changes is that the
record can now say more than "ask". It does not change what Sotto logs, the hosts it contacts, or the
pinned CLI version, and it does not make a mode's native meaning Sotto's business: Sotto states what it
will ask about, which is the part it can keep.
