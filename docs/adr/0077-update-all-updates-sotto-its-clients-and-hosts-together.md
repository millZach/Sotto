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
("installed → published"), or how far a press has come ("1 of 5 done", the restart counted), while it runs. Each
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
Muse on asks for its full Owl version; with both off it asks for its source version, the one it already runs, so no
host is updated ahead). A host whose earlier update this session is done is offered the new version too. One press runs, in order: Sotto's download alongside everything; this
computer's clients; each host's clients and then that host's own update to the pending version; last, Restart now.
Before a host is offered the pending version, main asks the releases page with a HEAD request whether
`Sotto-host-<version>-<platform>-<arch>.tar.gz` and its `.sha256` are published (github.com, already contacted for
updates; a redirect counts as published and is not followed). Until Sotto has heard a host's system from its own
download, any system's archive answers; a host whose own is missing is told so by its download, as before, and is
then asked about its own system. When nothing is published, or the page does not answer, the host stays aimed at the
running version and is offered the new one after the restart, as before. The page is asked again when the update
moves to another phase (never for a download's progress), so a host archive uploaded after the installer is found at
the next check. An update already under way keeps the version it started with, and a host newer than
the target is never taken down. This follows the `update-all` switch, read once at start: stable aims hosts at the
running version alone. Only packaged Windows updates itself, so macOS and Linux have no pending version and nothing
changes there.

Between that host update and Sotto's restart, the host runs ahead of this computer. Protocol version 1 is the same on
both sides, so the host reconnects, its threads work, and the update's check that it came back on the version it was
given passes. A refusal that would name version skew says "This host already runs Sotto X, which this computer
installs when Sotto restarts. Nothing on the host was lost. Restart Sotto to finish its update, then try again." in
place of asking for Sotto on this computer to be updated, and a connect that fails that way does not keep the host's
SSH session for Stop host. Later leaves the host ahead until Sotto next restarts, which stays usable the same way.

**7. Settings follows.** On Owl, Settings → Application → Updates offers Update all where it offered Download, and it
runs the same press.

## Consequences

- One press can restart a host and then Sotto. Each step's failure says what happened and what was kept, as the
  updater that owns it already does, and the card lists it with Try again.
- A window reloaded during a press loses only the press's own bookkeeping: what had started finishes in main, and a host
  still waiting for its clients is offered again.
- The update control, Settings → Providers and Settings → Hosts keep their own presses on Owl.
