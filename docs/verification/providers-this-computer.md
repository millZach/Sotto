# Settings > Providers is this computer's verification

October 16, 2026. Pull request #1083, on `fix/providers-this-pc` from `main` at 00f32d33.

## What was wrong

On the development laptop, Settings > Providers showed "Could not connect Muse. Sign in to Muse on this machine with
muse login, then connect it again." on the Muse tile for several minutes while the laptop's Muse was signed in. The
page read the providers of whichever host was selected for new work. Opening a thread on forge made forge the selected
host, and forge's Muse had never been signed in. Retry connection went to forge too, so pressing it changed nothing.

The laptop's own Muse was checked by starting its native binary the way the adapter does: `muse serve
--no-session-log` with the adapter's environment allow-list, in Sotto's data folder. It answered `model/list` with
four models from `providerCatalog`. Forge's Muse 1.4.8, found under mise's installs, answered with no models from
`bundledCatalog`, with both the trimmed environment and the full one.

## What Muse sends

The probes ran against Muse 1.4.9 on Windows and 1.4.8 on forge. Only the field values below were kept.

- Signed in, online: `source: "providerCatalog"`, 4 models.
- Signed in, with `HTTPS_PROXY` and `HTTP_PROXY` pointing at a closed local port: `providerCatalog`, 4 models.
- No sign-in (a fresh, empty home and config folder), online or with the same closed proxy: `bundledCatalog`, no models.
- Forge, no sign-in: `bundledCatalog`, no models.

`muse schema generate-ts` lists `ModelCatalogSource` as open: `providerCatalog`, `fakeCatalog`, `unresolvedCatalog`,
`bundledCatalog`, `configCatalog`. `ModelListResult.source` is required.

## In the built app

`tests/e2e/providers-this-computer.spec.ts` drives the built app. Forge runs the real headless host over the scripted
ssh, with its Claude Code signed in and its Codex signed out. This computer's providers run in the provider switch a
real app has, each one a test host. Forge is added through Add host, and then selected for new work.

- With forge selected, Settings > Providers shows this computer's Codex as Connected, with no error, and the other
  providers as Disabled, which is this computer's own enabled list
  ([`providers-with-forge-selected.png`](../../artifacts/providers-this-computer/providers-with-forge-selected.png)).
- Disconnect, then Connect, change this computer's Codex alone. Forge's Codex stays signed out, and forge stays selected.
- Forge's own Codex reads Not signed in on its tile in Settings > Hosts
  ([`forge-codex-tile.png`](../../artifacts/providers-this-computer/forge-codex-tile.png)).

Run it with `SOTTO_PROVIDERS_CAPTURE_DIR=<folder>` to write the two screenshots.

Forge's fake sign-in client words its own refusal, so the spec cannot show the host being named in an error.
`desktopHostRouter.test.ts` checks that a remote host's "on this machine" becomes "on Forge" on its entry and at the
top level, and that this computer's errors are left as they are.

Not checked: the real forge with the installed app. Pointing a second Sotto at forge would start or update the host
that the installed 0.1.38 uses.
