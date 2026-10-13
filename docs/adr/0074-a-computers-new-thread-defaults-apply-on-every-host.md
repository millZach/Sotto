# A computer's new-thread defaults apply on every host

## Status

Accepted October 11, 2026, by the owner's choice. It started as a bug report (#948): with a thread on the host forge
selected, Settings → Agents would not change "New threads start with" and showed "This action is not allowed from
this device. Check its permission policy or complete the action on the host." Asked how the page should work, the
owner chose one set of defaults: "No matter what computer I am on the agent default when I open a thread is set to
what I choose in settings." They chose to let the desktop set a host's projects directory, to list one row per
computer for it (variant b of
[the prototype](../prototypes/new-thread-defaults-every-host-prototype.html), over a single row naming the selected
host and a row on each host's tile in Settings → Hosts), and to have Settings say when a host holds back a permission
default.

This amends what #347 left implicit: there, the defaults were the selected host's. It brings the desktop in line with
the iPhone's own defaults ([ADR-0051](0051-the-iphone-takes-the-glow-look.md)).

## Context

Settings → Agents read and wrote the configuration of the selected host, the one whose thread or project the window
last selected, and did not say which host that was. A host takes a `configure` command from a paired client only for
the fields on its allow-list (`src/host/remoteCommands.ts`). The new-thread defaults came after that list and were
never added, and the projects directory was kept off it on purpose ("machine paths stay on the host"). So with a
remote host selected, every change on the page was refused. New thread also sent only the model with each
`create-thread`, so a remote host started the thread on its own effort and permission defaults whatever this
computer's were.

## Decision

**1. The new-thread defaults are this computer's own.** The desktop router sends a patch of only `newThreadModelId`,
`newThreadReasoningEffort` and `newThreadRuntimeMode` to the local host, whichever host is selected, and shows the
local host's values over the selected host's. With no model chosen, the model this computer inherits is resolved from
its own settings and accounts, not the selected host's. Settings lists this computer's models for them. New thread sends the
effort and permission a default chose with each `create-thread`, on this computer and on every connected host.

**2. A default applies where the host offers it,** as the iPhone's do. A remote host whose catalog does not list the
default model, or a computer with no model to offer, starts the thread on that host's recommended ready model. Effort and permission fit the model as before (#347).
Where no default chose the effort or the permission, the host's own choice applies. This computer keeps an
unavailable default model selected, as it did, so the thread can say what to connect.

**3. A permission default that lets a thread act without asking is a grant** (ADR-0004). On a host that does not let
this computer answer, New thread starts the thread on "Ask for approval" instead, and Settings names that host under
the row. A desktop connected over SSH normally may answer, so this is rare.

**4. Each computer keeps its own projects directory.** A Windows path means nothing on Linux. With a host connected,
Settings → Agents shows one row per computer, and each saves to its own computer. The `configure` command carries a
`hostId` for this, which only the desktop window sends and its router reads and never forwards. With only this
computer, the page is as it was.

**5. A host takes the projects directory and the new-thread defaults from a paired client.** They join
`REMOTE_CONFIGURATION_FIELDS`. A permission default other than "Ask for approval" needs the client's `remote-answer`
policy record, as a thread's own permission does. The projects directory adds no authority: `create-project` already
takes a path from a paired client. Keys stay on the host.

**6. `newThreadRuntimeMode: null` puts the permission default back to the provider's own.** JSON drops an undefined
field on its way to a host, so "Provider default" sends null.

## Consequences

With no local host running there is no "this computer" to keep the defaults on, so they are the selected host's
again; that host now takes them.

A thread the iPhone or a host opens itself still uses that host's own defaults, or the iPhone's.

A host from before this change refuses the new fields as it always did, until it is updated.
