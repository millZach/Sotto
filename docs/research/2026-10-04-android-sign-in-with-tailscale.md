# Signing in to Tailscale from the Android app: two routes tried

Tried October 4, 2026, for the proposed Android client (ADR-0057). The question: can the phone app list the owner's computers from Tailscale, so the owner signs in once instead of typing each computer's name? [PR #357](https://github.com/millZach/Sotto/pull/357) (ADR-0031, proposed) weighed signing in on the phone and rejected it, mainly because Tailscale's OAuth apps are alpha. This note adds what was measured since. Nothing here is a decision.

## Route 1: Tailscale OAuth apps cannot list devices

Tailscale's OAuth apps ([docs](https://tailscale.com/docs/features/oauth-apps)) are an authorization-code flow on behalf of a user, created by a tailnet admin through the API. Two creation requests were sent to the API and refused, and nothing was created:

| Asked for | Tailscale's answer |
|---|---|
| A redirect back into the app, `com.millzach.sotto.android:/oauth` | `redirect URI "com.millzach.sotto.android:/oauth" is not permitted` |
| A scope to read the device list, `devices:core:read` | `invalid scopes: ["devices:core:read"]` |

The documented scope is `auth_keys:create:once` only: a single-use key to add a new device. The token exchange also needs the app's client secret. So an OAuth app cannot give a phone its owner's device list, which settles #357's rejection on firmer grounds than the alpha label.

## Route 2: Tailscale built into the app works on the emulator

The app can be its own Tailscale device: Tailscale's Go library for embedding (`tsnet`, tailscale.com v1.104.0), built for Android with gomobile (Go 1.27, NDK 27, arm64 and x86_64). A throwaway probe app was run on the Android emulator (API 35) against a Tailscale Serve echo on the developer's computer:

- **Sign-in.** A node started from an empty state folder with no auth key asked for login and gave the usual `login.tailscale.com` URL. After the owner approved it in a browser, the node was Running as a device owned by that user.
- **The computers.** The node's own status listed all 48 devices on the tailnet.
- **Reaching one.** An HTTPS request from OkHttp, carried through the node by a loopback forwarder, reached the computer with the platform's own TLS check of the `*.ts.net` name.
- **Checked from outside the app.** The echo, which Tailscale Serve fronts, reported the request coming from the probe's own tailnet address. A request from the emulator without the node had arrived from the computer's own address instead. `tailscale whois` on the computer named the probe's device and its owner.

Two things Android needs that a desktop build does not, each found by its failure:

1. **Network interfaces.** Android refuses apps the netlink route socket, so Go's interface list fails (`netlinkrib: permission denied`). Tailscale's own fallback for this (`feature/androidbin`) is compiled out of cgo Android builds, which gomobile always produces, because Tailscale's Android app registers its own source from Java. The app must call `netmon.RegisterInterfaceGetter` before starting the node. A synthetic interface carrying the outbound source addresses was enough here.
2. **Log state.** With no home folder, the node panicked (`no safe place found to store log state`). Setting `TS_LOGS_DIR` to the app's folder fixes it. `TS_NO_LOGS_NO_SUPPORT=true` also turns off Tailscale's log upload, which Sotto must not do anyway.

Not tested yet: a physical phone, running beside the phone's own Tailscale app, battery and background behaviour. The Go library adds about 30 MB per CPU architecture before compression.

## What it would mean for Sotto

- **A new host.** The embedded node talks to Tailscale's coordination servers and DERP relays, which the README's "Privacy and cost" section does not name today. That is an ADR and a README change first.
- **A second device per phone.** The phone appears in the tailnet beside its own Tailscale app's device. Uninstalling the app does not remove it, so the app would need a Sign out that logs the node out.
- **Identity for pairing.** Through the embedded node, Tailscale Serve added `Tailscale-User-Login` with the owner's login to each request reaching the computer; the computer's own request carried none. That is the identity #357 proposes to admit a phone by. Together the two would let an owner sign in once and reach every computer that runs Sotto without typing a name or a code. Admission would still grant no authority (ADR-0004).

The probe code and the full attempt-by-attempt record are on [`spike/android-embedded-tailscale`](https://github.com/HermeticOrmus/Sotto/tree/spike/android-embedded-tailscale) in the contributor's fork, at `docs/spikes/android-embedded-tailscale.md`. It is not meant to merge.
