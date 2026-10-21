# Update all updates Sotto, its clients and its hosts together

## Status

Accepted October 12, 2026, by the owner's choice, as an Owl feature (ADR-0072). The owner asked for an "update all
button, similar to what T3 Code just released", that pops up when there is a new update, updates every provider, the
application on its current track and any remote host, and then asks to restart. They chose that it shows whenever
anything has an update, not only Sotto, and that its restart offers Restart now alone, the threads it stops resuming
after it (ADR-0076). Of three placements in `docs/prototypes/update-all-prototype.html` (a pill in the top strip, the
sidebar foot, a card in the corner) they chose variant c, the corner card.

On Owl it takes over from the client update card (ADR-0042) and the host update pill (ADR-0040). Both stay as they are
on stable, and the updaters behind them are unchanged.

Amended October 14, 2026, by the owner's choice: a host updates to the version this computer is downloading, before
Sotto restarts (decision 6), and the card's list became the press's steps. Of three layouts in
`docs/prototypes/update-all-hosts-together-prototype.html` (stacked rows, one block per machine, steps) they chose
variant c, "Steps".

Amended October 21, 2026: a new version of Sotto has every machine check its clients afresh (decision 6), so their
updates are listed in the same card rather than after the restart.

## Context

Three things in Sotto go out of date, and each had its own place: the update control for Sotto itself (Windows only),
the corner card for provider clients on this computer, each host's tile in Settings → Hosts for that host's clients,
and the pill on the Threads page for a host running an older Sotto. Bringing everything up to date took a press in
each, in an order that mattered: a host's clients before its restart, and Sotto's restart last. T3 Code's Update all
(pingdotgg/t3code#14678) updates every outdated provider on every connected machine at once and reports in one toast;
it does not touch the app or its servers.

## Decision

**1. One card in the corner.** With the `update-all` Owl feature on, a card appears in the window's bottom-right
corner, where the client update card was, whenever any of these is true: Sotto has a release to download, is
downloading one or has one ready to install; a client on this computer or on a connected host is behind; or a host
runs an older Sotto than this computer asks for. It pops up by itself when something new appears. Its chevron folds it
into a pill that says where things stand, and Not now hides it until something new is published or Sotto restarts.

October 14, 2026 amendment: the list is the press's steps, in the order it runs them, as an ordered list with a thin
rail between the marks that turns green once a step is done. **Download Sotto Owl** (its detail begins "This computer
·"), each client (**Update Codex**, with its own installed and published versions and "This computer ·" or the host's
name before its detail), each host's own update (**Update forge's host**) after that host's clients, and last
**Restart Sotto**, which reads "Last. Sotto asks before it restarts." until the restart is ready and then says what it
installs and what happens to the threads on this computer that it stops. The head carries Sotto's own versions once
("installed → published"), or, while a press runs, how many of the steps shown are done ("1 of 5 done": every step
in the list counts, the restart and a download finished before the press among them). Each
sentence is said once: what a step says is not repeated below the list, and a note stays below only when no step says
it ("Threads keep working while clients update.", or that a host still waiting for its threads is offered again if
Sotto restarts first). Try again, Stop N threads and update, Cancel update and Copy commands stay inside their step. A
host's step shows its versions only when they are not Sotto's pair in the head. Earlier the list was grouped by machine
with the versions in a right-hand column, which squeezed the sentence beside a long Owl version into a column a few
letters wide.

**2. Update all, one press.** It starts Sotto's download, puts every client Sotto can install into its machine's update
line (on this computer and on each connected host that offers client updates), and updates each host that needs it.
A host's own update waits until the clients it was asked to update have finished, so its restart does not cut one
off. Everything else runs side by side, each in the updater that already owned it.

October 16, 2026 amendment: the wait is now kept by the host update itself (`HostUpdates` in main), whatever starts it.
Only the card's first press kept it before, and on October 16 Try again on forge's host restarted it while Codex was
installing there. A host whose client update line is running, a client waiting in it or updating, moves to waiting
and begins by itself once the line is empty: Update all's press and Try again, the host update pill's Update and Try
again (ADR-0040), Update when they finish and Stop N threads and update alike. Cancel update takes it back to needing
an update, and an update already under way is never interrupted. Its restart still waits: a client put in the line
after the download began holds the installed update at its restart step until the line is empty, and Cancel update
stays refused there, as it is once the host has begun to install. The line is read from what the router last
published for that host, in place, because the question is asked on every change, and a host that is not connected
has no line running. The card words the wait as its own, "Updates once forge's clients have.", and the pill as "forge
waits for its clients". A held restart reads "Restart forge's host once its clients have" on the card, "Updating forge
· waits for its clients" on the pill, and "forge restarts once its client updates finish." in the panel.

The same day: a client step on a host that was seen waiting or updating in the host's line since the press, or since
its Try again, and is later out of the line with no result of its own, lost its line. A host keeps its results in
memory, so one that restarted reports none, and that counts as no result. While the host is out of reach, the step
stays listed as "Waiting to hear from forge…", so the press is not read as over. A connected host says what it still
has in its first shell, so one that leaves the client out, as a restarted host with client checks off does, lost the
line too. The step counts as done only when the host runs another version than it did when the step was seen; whether
the client reads as behind cannot say, because one whose registry did not answer reads as not behind.
A step whose host was out of reach meanwhile reads "forge restarted before Codex updated. Nothing was changed. Try
again."; one taken out of the line some other way, as by Cancel update on the host's tile, reads "The Codex update on
forge stopped before it finished. Nothing was changed. Try again." Both offer Try again, which puts it back in the
line, where before the step read "Starting…" for good. The moment between
the line's reply and the host's next shell, which the host holds back up to 16 ms, is never read as a loss, because
the step is marked as seen only once the host says it is in the line. This computer's own line cannot be lost without
the card going too, so only a host's steps are read this way.

The same day, by the owner's choice: a run that ends with everything updated goes by itself. Once the card reads
"Updated", with no step failed and none waiting for a host's threads or clients, it goes 5 seconds later, as Dismiss
does, and comes back only when something new is published. A step left for the user to do by hand does not hold it.
The count does not run while the pointer is over the card or its pill or focus is inside either, and starts again
from the beginning once both have left, so the card never goes while someone reads it or is about to press. Nothing
announces it: no countdown and no message. "Not everything updated" stays, with its Try again, until it is dismissed,
and "Restart to finish" is never put away by itself.

**3. What Sotto cannot do is listed, not pressed.** A client installed with something Sotto does not drive shows the
command to run. A host Sotto did not start shows that it cannot be restarted from here and offers its commands to
copy. Neither counts toward the press.

**4. A host's working threads finish first.** Restarting a host stops its threads. Stable hosts cannot resume them yet;
matching Owl hosts follow their own feature list and setting (ADR-0076 decision 8, ADR-0078). On either track a host
with working threads updates once they finish, the way
Update when they finish does (ADR-0040), and the card offers Stop N threads and update for anyone who would rather not
wait, and Cancel update, as the pill did, while the host waits or downloads. The restart of Sotto does not wait for such
a host. The wait lives in this running Sotto, so the restart prompt says that if Sotto restarts first, Update all offers
that host again.

October 13, 2026 amendment: matching Owl host archives extend the original stable-only host distribution. The busy-host
wait, explicit Stop N threads and update choice, and Cancel update stay the same on both tracks.

**5. Restart now, last.** Once Sotto's download is ready, nothing the press started is still running and nothing is
left to offer, the card asks to restart; Sotto downloaded from the update control waits behind what is still offered. It says how many threads on this computer are working, and whether they carry on after (ADR-0076). Restart
now installs at once: the card is the question the install dialog would have asked. Later folds the card, and the
update control keeps the download. Where Sotto cannot update itself (macOS, Linux, a development run), the card covers
clients and hosts and never asks to restart.

**6. It drives what exists, from the window.** The card sends the commands the update control, the client update card,
the host tiles and the host update pill already send, and reads the state they already publish. It adds no channel and
no updater. Two things change underneath: this computer's client updates also ride its own `clientHosts` entry, so the
card lists them whichever host is selected, and `queue-client-updates` takes a `hostId` the desktop's router reads and
never sends on, as `configure` does (ADR-0074), so the press reaches this computer whichever host is selected. A failed
client says what happened and points to Settings → Providers or Settings → Hosts for what the installer printed. A host updates to the version this running Sotto asks for; when a restart brings a newer one, the card
offers it after the restart.

October 14, 2026 amendment: a host updates to the version this computer is downloading, before Sotto restarts. When
Sotto finds a new version of itself (offered, downloading or downloaded), each connected host Sotto can update is
listed at once, aimed at the host version that new Sotto asks for (`hostReleaseVersion`: an Owl build with Usage or
Muse on asks for its full Owl version; with both off it asks for the stable release that build is built on, never the
version this computer runs, so a host moves only when the release number does). A host whose earlier update this session is done is offered the new version too. One press runs, in order: Sotto's download alongside everything; this
computer's clients; each host's clients and then that host's own update to the pending version; last, Restart now.
Before a host is offered the pending version, main asks the releases page with a HEAD request whether
`Sotto-host-<version>-<platform>-<arch>.tar.gz` and its `.sha256` are published (github.com, already contacted for
updates; a redirect counts as published only when it points at `release-assets.githubusercontent.com`, where GitHub
serves release files, and is not followed). It asks for the host's own system only. The launch
script reports it with every launch over SSH (`linux-x64`, the pair the archive's name carries), and the tailnet store
keeps it for a host reached over its tailnet, where no launch runs. A host whose system Sotto has not heard, because it
has never launched or reached it over SSH, is asked nothing: another system's archive says nothing about its own, so
it is offered the new version after the restart, as before. When nothing is published, or the page does not answer,
the host stays aimed at the running version and is offered the new one after the restart, as before.

While the page has not answered, the card lists a host Sotto started as a step, "Checking the releases page for its
update…", and Update all covers it; a host Sotto did not start keeps its commands. A press made then starts everything else and records the host, which joins the press once the
answer comes, aimed at whatever it found: the new version, this computer's own, or nothing, when it leaves the press.
It still waits for the clients the press asked of it. A check that begins while a press runs, as when the page is asked
again because Sotto's download moved on, joins the same way. The card never offers the restart while the check of a host whose step it shows is
pending, or a host's update is running; a host with no step, such as one Sotto did not start, holds nothing back. Main
holds the restart too: while a host update runs, Restart now (from the card or the update control) restarts nothing
and says "Sotto did not restart while it was updating the host on forge. Nothing was lost. Restart again once that
update has finished." A quit stops a host download, as Cancel update would, and leaves an update the host has begun to
unpack to its launch script, which finishes the install and restart on the host after the connection closes. The page is asked again when the update
moves to another phase (never for a download's progress), so a host archive uploaded after the installer is found at
the next check. An update already under way keeps the version it started with, and a host newer than
the target is never taken down, with one exception: when the pending version goes away or changes, a host update still
downloading it stops, as Cancel update would, and the host is offered its new target. One the host has begun to unpack
finishes, and its step says "forge was already installing X when this computer stopped updating to it, so it finished.
Nothing was lost." An Update pressed while the page is still being asked shows as started and fixes its version from
the answer, so one press downloads and restarts the host once. This follows the `update-all` switch, read once at start: stable aims hosts at the
running version alone. Only packaged Windows updates itself, so macOS and Linux have no pending version and nothing
changes there.

Between that host update and Sotto's restart, the host runs ahead of this computer. Protocol version 1 is the same on
both sides, so the host reconnects, its threads work, and the update's check that it came back on the version it was
given passes. A refusal that would name version skew says "This host already runs Sotto X, which this computer
installs when Sotto restarts. Nothing on the host was lost. Restart Sotto to finish its update, then try again." in
place of asking for Sotto on this computer to be updated, and a connect that fails that way does not keep the host's
SSH session for Stop host. Later leaves the host ahead until Sotto next restarts, which stays usable the same way.
When both sides run Owl, a host on a later Owl build of the same release counts as newer even once the pending version
has gone: it is never offered a downgrade, and a refusal asks for Sotto on this computer to be updated.

October 21, 2026 amendment: when Sotto finds a new version of itself, every machine checks its clients afresh. Each
machine's readings were taken when its providers connected, so when a new Sotto appeared the card listed only the
clients already known to be behind, and the ones published since appeared on this computer and on forge only after the
restart. Now, the first time the update service offers, downloads or has downloaded a version it has not found before
in this run (never for a download's progress), main has this computer's coordinator ask the registry afresh, keeping
the outcome of any update already run, which a press may still be reading, and sends `check-client-updates` to each
connected host that offers client updates. Every host already takes the command, so host protocol version 1 is
unchanged; what changed is what it does. `check-client-updates` used to set every outcome aside, and now keeps an
outcome that still describes the client (the same version installed, the same release), so an Update all press reading
a host's earlier "updated" or "failed" loses nothing to the check (ADR-0042). Such a host lists a new host feature,
`client-update-outcomes`, offered with `client-updates`, and is asked whatever its readings hold. The feature is a new
value in hello's existing `features` list, which every v1 client reads as a list of names, so an older host simply does
not list it and an older desktop ignores it; no field or command is added. A host that does not list it may still set
outcomes aside, so while it holds any it is left to its own checks, as before. The feature says what the host does, so
the answer does not move as this computer moves on to later releases, as a comparison with this computer's own version
would. A host whose update line is running is asked once the line is empty, decided from the shell the host pushes
rather than a read of the host's state, since that runs on every push while the check is owed. A host that would check
a provider this build holds is not asked. This computer remembers a check afresh asked for while its own update line
runs, and asks once, when the line is empty.

The press does not wait for the answers. A client found behind while a press of Update all is under way joins that
press: the card puts it into its machine's update line, as the press did its own clients, and a host's update already
waits for that line before it restarts (decision 2). The press is under way while a step it asked for is still going, a
host waits for its clients or for the releases page, or the Sotto it downloaded waits for the restart. Once it is not,
joining closes for good: a step's own Try again, after the press or during it, never opens it again. A client whose update the press ran and which a newer release then
leaves behind is offered again in the same way, rather than reading as a step still starting. The order stays as above.
Nothing reads the `update-all` switch for the checks: on stable the client update card and each host's tiles read the
same readings, sooner, and nothing new is shown. Where Sotto does not update itself, no version is found and nothing
changes.

**7. Settings follows.** On Owl, Settings → Application → Updates offers Update all where it offered Download, and it
runs the same press.

## Consequences

- One press can restart a host and then Sotto. Each step's failure says what happened and what was kept, as the
  updater that owns it already does, and the card lists it with Try again.
- A window reloaded during a press loses only the press's own bookkeeping: what had started finishes in main, and a host
  still waiting for its clients is offered again.
- The update control, Settings → Providers and Settings → Hosts keep their own presses on Owl.
- Every launch over SSH, including an admin connection's, now tells this computer the host's system, and a host's
  tailnet entry keeps it. A host this build has only reached over its tailnet has no system yet, so its first update
  after this build still comes after Sotto restarts; that update's own SSH connection records the system for the next.
