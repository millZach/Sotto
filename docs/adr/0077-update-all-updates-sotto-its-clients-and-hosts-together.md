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
runs an older Sotto than this computer asks for. It lists them by machine (Sotto, this computer, then each host) with
what is installed and what a press installs. It pops up by itself when something new appears. Its chevron folds it
into a pill that says where things stand, and Not now hides it until something new is published or Sotto restarts.

**2. Update all, one press.** It starts Sotto's download, puts every client Sotto can install into its machine's update
line (on this computer and on each connected host that offers client updates), and updates each host that needs it.
A host's own update waits until the clients it was asked to update have finished, so its restart does not cut one
off. Everything else runs side by side, each in the updater that already owned it.

**3. What Sotto cannot do is listed, not pressed.** A client installed with something Sotto does not drive shows the
command to run. A host Sotto did not start shows that it cannot be restarted from here and offers its commands to
copy. Neither counts toward the press.

**4. A host's working threads finish first.** Restarting a host stops its threads, and a host runs a stable host build
that cannot resume them yet (ADR-0076 decision 8). So a host with working threads updates once they finish, the way
Update when they finish does (ADR-0040), and the card offers Stop N threads and update for anyone who would rather not
wait, and Cancel update, as the pill did, while the host waits or downloads. The restart of Sotto does not wait for such
a host. The wait lives in this running Sotto, so the restart prompt says that if Sotto restarts first, Update all offers
that host again.

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

**7. Settings follows.** On Owl, Settings → Application → Updates offers Update all where it offered Download, and it
runs the same press.

## Consequences

- One press can restart a host and then Sotto. Each step's failure says what happened and what was kept, as the
  updater that owns it already does, and the card lists it with Try again.
- A window reloaded during a press loses only the press's own bookkeeping: what had started finishes in main, and a host
  still waiting for its clients is offered again.
- The update control, Settings → Providers and Settings → Hosts keep their own presses on Owl.
