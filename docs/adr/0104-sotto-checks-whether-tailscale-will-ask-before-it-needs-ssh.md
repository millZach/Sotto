# Sotto checks whether Tailscale will ask before it needs SSH

## Status

Proposed October 21, 2026, for Zach's decision. Nothing here is accepted until he says so, and nothing is built. Zach asked on October 21 how to tell whether his tailnet uses Tailscale SSH's `check` mode, and asked for Sotto to make that easy for anyone. It builds on [ADR-0025](0025-headless-host-and-client-identity.md)'s September 27 amendment (the approval wait while connecting), [ADR-0034](0034-add-host-lists-this-computers-tailnet.md) (Add host reads this computer's `tailscale status`), [ADR-0053](0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) and [ADR-0088](0088-sotto-leans-on-tailscale.md), and goes with [ADR-0105](0105-hosts-reach-each-other-over-host-links-the-desktop-sets-up.md), which takes branch moves off SSH. It would be an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)).

## Context

A machine on a tailnet can answer SSH with Tailscale SSH instead of its own SSH server. The tailnet's policy file then decides, rule by rule, whether a connection is let in on the user's tailnet identity (`"action": "accept"`) or held until the user signs in to Tailscale again in a browser (`"action": "check"`), and for how long an approval lasts (`checkPeriod`, 12 hours unless the rule says otherwise).

Zach's tailnet holds forge's SSH in `check` mode (ADR-0025, September 27 amendment, #429). Sotto already copes with that while it connects: the launcher reads Tailscale's banner on ssh's stderr, waits up to five minutes on the Tailscale step, and offers **Open approval page** (`src/main/hosts/tailscaleApproval.ts`). It finds out only once a sign-in is already held, though, and only for the sign-ins it makes while someone is looking. Each branch move under ADR-0082 opens a fresh SSH session, and a move started by an agent at night would wait for a browser nobody opens.

What Tailscale's own documentation says, checked on October 21, 2026:

- Tailscale SSH "takes over port 22 for SSH connections incoming from the Tailscale network", and "there is no way to configure Tailscale SSH to use a different port". It runs only on a machine whose owner turned it on (`tailscale set --ssh`), and its server runs only on Linux and on Macs with the open-source `tailscale` and `tailscaled` command line, so the Mac App Store and standalone Tailscale apps never answer SSH this way, and nor does Windows. Ordinary SSH servers "still run ... on top of Tailscale as the network layer" ([Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)).
- `action` is `accept` or `check`. When a connection matches a `check` rule and an `accept` rule, the `check` rule applies, so adding an `accept` rule beside a `check` rule changes nothing. `checkPeriod` runs from one minute to 168 hours, or `always`, and changing it is on the Premium and Enterprise plans only ([policy syntax](https://tailscale.com/kb/1337/policy-syntax)).
- Tailscale's sample default policy has one SSH rule, `check`, from the tailnet's members to their own devices ([sample policies](https://tailscale.com/kb/1192/acl-samples)), while the Tailscale SSH page says check mode is "not enabled by default". Which one a given tailnet has depends on its policy file, so Sotto cannot assume either.
- In Tailscale's open-source server, a held connection waits until Tailscale's control server answers, with no limit of its own (`tailcfg.SSHAction.HoldAndDelegate`; `ssh/tailssh/tailssh.go`). The words of the banner come from the control server, not the client, so they can change without an update.
- A device that runs Tailscale SSH publishes SSH host keys, which `tailscale status --json` shows as the peer's `sshHostKeys`. Tailscale's own code uses them "as a proxy" for Tailscale SSH being on. Nothing on the command line shows a user who is not the tailnet's admin whether a rule is `check` or `accept`; only the admin console's access controls page does.

So from this computer Sotto can know whether a machine answers with Tailscale SSH, and it can see a hold when one happens. It cannot read the policy ahead of time, and a sign-in that went straight in may only mean an approval in the last 12 hours.

## Decision

**1. Moves never sign in.** A branch travels over the host socket (ADR-0105 decision 8), on a tailnet connection or on the SSH connection's forward that is already open, so no move opens SSH and `check` mode cannot hold one. A move to a host that is not connected is refused by name ("Forge isn't connected. Connect it, then try again. Nothing was moved."), never sent by a new sign-in. That leaves only the presses ADR-0053 names as needing SSH: Add host, pairing again, Stop host, Start at boot, **Phones…**, Forget and saving **Edit connection**, and host setup threads, which run `ssh` themselves.

**2. Sotto looks before it asks.** No extra connection is made to find out, since a probe sign-in would itself ask for an approval. Sotto uses two things it already has:

- **What this computer's Tailscale says.** When Add host lists a device, and each time a saved host connects, main reads whether the device publishes SSH host keys (`tailscale.ts` already does). A device that does answers SSH with Tailscale SSH and may be held. One that does not, a Windows machine or a Mac on the standalone app among them, is reached by its own SSH server, and Tailscale never holds it.
- **What Sotto saw.** When the launcher reads Tailscale's banner on a host, Sotto records when, for that saved host, beside its tailnet state (`remote-host-tailnet.json`). Nothing else: no URL, no banner text. A host held once is a host Tailscale asks for, until a sign-in goes straight in more than a check period (12 hours) after the last approval.

**3. It says so in plain words, where the press is.** A prototype comes first. What it should show:

- **At Add host**, for a device that runs Tailscale SSH, before **Add it**: "Forge uses Tailscale SSH. Tailscale may ask you to approve this sign-in in your browser." The approval wait itself is unchanged.
- **On the host's row**, once Sotto has seen a hold there, under Edit connection: "Tailscale asks you to approve SSH sign-ins to forge in your browser. Sotto needs SSH only to set forge up, stop it, start it at boot, pair phones or forget it." With **How to stop the asking**, which opens the guide's section.
- **Before a press that needs SSH** on such a host: "Tailscale may ask you to approve this in your browser." on the press's own surface, before it signs in.
- **When a host prefers SSH only** and Tailscale asks there, the row offers to reach it over the tailnet instead, since a tailnet connection needs no approval (ADR-0053).

**4. Two ways to stop the asking, both the owner's.** The guide's "Hosts over Tailscale SSH" section gains them, and Sotto never changes Tailscale's settings or policy itself:

- **Let Sotto's machines in without a check.** The tailnet's admin changes the rule covering them from `check` to `accept`. Adding an `accept` rule beside a matching `check` rule does nothing.
- **Use the machine's own SSH server.** Turn Tailscale SSH off on that machine (`tailscale set --ssh=false`) and run OpenSSH there, or keep Tailscale SSH and run OpenSSH on another port, such as 2222, and give the saved host that port. Tailscale holds only port 22.

**5. A check the owner can run.** The guide says how, in this order:

1. **Does the machine use Tailscale SSH?** On this computer: `tailscale status --json`, and look for `sshHostKeys` in the machine's entry. On the machine itself: `tailscale debug prefs`, and look for `"RunSSH": true` (to be checked on forge before the guide says it).
2. **Does the policy hold it?** In the Tailscale admin console's access controls page, look in the `ssh` section for a rule with `"action": "check"` that covers the machine. Only the tailnet's admin sees this.
3. **Does it hold now?** `ssh -o BatchMode=yes -o ConnectTimeout=15 forge true`. A banner naming `login.tailscale.com`, or a wait that does not end, means Tailscale is holding it. Going straight in means it is not holding now, which may only be because of an approval in the last 12 hours.

**6. Privacy.** No new host is contacted. Sotto runs only this computer's `tailscale status`, as Add host already does. It records a time per saved host and nothing from the banner, and the approval page's address still reaches only the window and the browser on a press (ADR-0025).

## Consequences

- An agent's move at night no longer waits on a browser, because it no longer signs in.
- The owner learns, before pressing, that a press will ask for an approval, and learns once why, and what would stop it.
- Sotto's knowledge is a hint: a host that went straight in may ask next time, and Sotto words it as "may ask". The approval wait of ADR-0025 stays the thing that copes with a hold.
- If Tailscale changes its banner's words, Sotto stops recognising a hold and falls back to today's timeout sentence. The banner's words are matched in one place (`tailscaleApproval.ts`) so a change is one edit.
- A Mac reached by Remote Login is never held, since its Tailscale app does not run Tailscale SSH.

## Proof, when built

Unit tests of the reading (`sshHostKeys` present, absent, a Windows peer), of the record of a hold and of when it lapses, and of the words for each case. The built app under Playwright with the scripted `ssh` and `e2e-tailscale-status.json` stand-ins, at 1600×1000, 1280×800 and 820×560, light and dark. Then a live check against forge, recorded in `docs/verification/`.
