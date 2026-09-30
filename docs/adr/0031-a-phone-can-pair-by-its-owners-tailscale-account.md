# A phone can pair by its owner's Tailscale account

Proposed on September 26, 2026, not accepted. The owner asked for the iPhone app to reach hosts "through Tailscale", because most of their machines, and other people's, have no screen to read a pairing code from. The iPhone client in #225 already finds a host by its machine name on the tailnet (MagicDNS, answers inside Tailscale's address ranges only) and needs no new host for that. What is left is the code: on a machine without a screen, getting one means an SSH session to run `--pairing-code`. This record proposes letting the host admit a phone because Tailscale says the phone belongs to someone the host's owner allowed. It amends ADR-0025, where a short-lived code is the only way a client beyond SSH is admitted, and changes nothing in ADR-0004: being admitted still grants no authority.

## Considered options

**Sign in to Tailscale on the phone and list machines.** Rejected. Tailscale's OAuth apps are in alpha, each is created by an owner or admin of one tailnet, and only that tailnet's users can sign in through it, so Sotto cannot ship one sign-in for everyone: each owner would register their own app. The phone would contact `api.tailscale.com`, a new host under the README's privacy rule, and keep a token able to read the tailnet's device list. The name lookup already finds the host without any of that. ([OAuth apps](https://tailscale.com/docs/features/oauth-apps))

**Keep the code as the only admission.** The status quo. It works everywhere Tailscale works, including tagged devices, but on a headless machine it costs an SSH session per phone.

**Admit a phone by the Tailscale identity Serve reports.** Proposed. Tailscale Serve adds `Tailscale-User-Login` (and a display name) to each request it proxies from the tailnet, strips any copy the caller sent, and leaves both off for tagged devices and Funnel traffic. The host learns nothing Tailscale doesn't already know, and no new host is contacted. ([Serve identity headers](https://tailscale.com/kb/1312/serve))

## Decision, if accepted

- Off by default. The host's owner allows a login with a local administrative command, `--allow-tailscale-login alice@example.com`, and removes it with `--deny-tailscale-login`. Only the local administrative path changes this list, the way it alone issues codes today.
- The host lists a new host feature, `tailscale-login-pairing`, when at least one login is allowed. A phone that sees it offers "Pair as alice@example.com" on step 2, beside the code, which stays.
- `POST /v1/pair-tailscale` with `{ v: 1, name }` redeems the header once for a client token, the same record `PairedClients` keeps for a code, with the login noted beside the client ID for Forget and revocation. It is refused when the header is missing, the login is not allowed, or the request did not come through Serve (next point).
- The header is trusted only on requests Serve made. Serve forwards to a loopback port, which any account on the host machine can also reach and could send a forged header to. So the Serve target carries a private path prefix, `http://127.0.0.1:<port>/serve-<secret>/`, generated per install and kept in the host's owner-only data folder; the host honours the header only under that prefix and ignores it everywhere else. The secret never leaves the machine, is never logged and is not a credential a client ever holds.
- Pairing by login admits and nothing more. Answers still need a `remote-answer` policy record for that client (ADR-0004), set with `--allow-answers` as today.
- Removing a login stops new pairings under it; phones already paired keep their tokens until revoked with `--revoke-client` or Forget, as with a code.
- The login and display name are shown to the owner when allowing and on the phone when pairing; neither is written to a log.

## Open before acceptance

- Whether the private prefix is enough on a machine with other accounts. The secret sits in the owner's data folder and in Serve's configuration, which non-root accounts cannot read without Tailscale operator rights; that needs checking on `forge`, and on macOS hosts, before this is accepted. If Serve can target a Unix socket with owner-only permissions, that is stronger and replaces the prefix.
- Whether a device shared into the tailnet should ever pass. Serve adds the headers for people outside the tailnet who accepted a device share too; the allow list decides, but the command should say so when it allows a login from another tailnet.
- The phone's step 2 layout for two ways to pair, which needs a mock-up in `docs/prototypes/iphone-client-prototype.html`.

## Consequences

A phone can pair with a headless host without SSH, after the owner allows their login once on that host. The code path stays for tagged devices, other people's phones and any host that never turns this on. The host protocol grows by one feature and one route, which version 1 allows. Serve's configuration becomes part of setup, with the prefix the host prints, and `docs/guide.md` and the iPhone README must say how.
