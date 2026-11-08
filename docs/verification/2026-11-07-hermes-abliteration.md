# Abliteration in the local Hermes Owl

Local branch `feat/hermes-abliteration`, based on `fix/hermes-python-path` at
`ad352c36a9e8bb57c172d0ac401efe4118c65978`. No push, PR or merge.

## Routes and credentials

The live `https://api.abliteration.ai/v1/models` response confirmed all three
requested IDs. Names and context sizes match the existing OpenCode provider:

| Model | ID | Context |
| --- | --- | --- |
| Abliterated Large V2 | `abliterated-model-large-v2` | 1,048,576 |
| Abliterated Large Flash | `abliterated-model-large-flash` | 1,048,576 |
| Abliterated Model | `abliterated-model` | 262,144 |

All three use `own-abliteration/<model-id>` in the Hermes catalog. The deprecated
`abliterated-model-large` is omitted. Image input stays off: no image round trip
was verified. Changing saved servers keeps the Abliteration route.

Availability checks Keychain service `abliteration`, account `default`, without
reading its secret. The generated config carries only
`/usr/bin/security find-generic-password -s abliteration -a default -w`.

Hermes 0.23.0 drops `key_cmd` when resolving its legacy `custom_providers` list:
`hermes_cli/runtime_provider_custom.py:_match_legacy_custom_provider` returns no
command, so the runtime uses `no-key-required`. A real turn confirmed HTTP 401.
The same resolver preserves the command on the current `providers` map. Only
Abliteration uses that map; the Refuseless route, model, config and ordering are
unchanged. No Hermes source or OpenCode configuration was changed.

## Native check outside Sotto

Bundled Sotto's actual `HermesAcpHost` and `HermesRuntime` into a temporary Node
entry, as in the Python-path check. Hermes 0.23.0 ran its real gateway and ACP
viewer with fresh temporary Hermes homes, a temporary empty project and the
generated config. The ordinary macOS HOME was preserved so Keychain could find
its existing search list; using a replacement HOME made `security` exit 44.
No Sotto app was launched.

Selected `own-abliteration/abliterated-model-large-flash`, sent
`Reply with exactly ABLITERATION_OK. Do not use any tools.`, received
`ABLITERATION_OK`, and settled idle. All three models appeared before the turn
and remained after `ownServersChanged()`. Hermes reported a 1,048,576-token
context window. Its native usage record held 10,664 input tokens, 7 output
tokens and an estimated cost of $0.010678, about 1.1 cents. A separate 37-token
direct request confirmed the Keychain key
while diagnosing the legacy resolver; failed attempts generated no reply.

After gateway shutdown, both the root and project configs contained `key_cmd`
and no `api_key` for Abliteration. A byte-for-byte scan read the key only through
a Keychain pipe and found zero matches across all three temporary homes,
workspace files, and probe/check logs. It excluded `.git` internals and
`node_modules`; the committed diff is checked separately. The key was never
printed or written by the check.

## Focused checks

- `npm run typecheck` and `npm run lint` passed before the config-format fix.
- After that fix, Node/main and Node-test typechecks and targeted ESLint passed.
- `npm exec -- vitest run tests/unit/main/hermes.test.ts`: all six tests passed.
- No full suite, Playwright, e2e, design capture or app launch.

## Local Owl build

Built `0.1.43-owl.20261107.5` at `release/mac-arm64/Sotto.app` from
`229e938d6008b9bd9ab35fdee757c90797f51969`. This follows the `.4` build:
asset verification, the Electron/Vite bundle, Core ML helper, key listener,
build provenance, then electron-builder directory packaging for macOS arm64
with `npmRebuild=true` and `extraMetadata.version=0.1.43-owl.20261107.5`.
The source package version is unchanged. The fresh `npm ci --ignore-scripts`
left node-pty's prebuilt spawn helper without execute permission; restoring
that dependency file's permission let asset verification pass.

The bundle's plist and packaged manifest both report `.5`. Its arm64 executable
and deep, strict code-signature verification pass. Packaged provenance matches
all 356 just-built artifacts and records build SHA-256
`ab3fa281b86bf320525595d01335b43f063d7081e112ede8d24e20d1dbfa8097`.
No app-launching package check was run.

The final key scan covered 14,345 files (2,102,619,622 bytes), including the
packaged app, generated configs, temporary Hermes homes, logs and the committed
diff. It found zero matches; `.git` internals and `node_modules` were excluded.

## Installation

Drake selected **Install now** on the question card. Ran `sotto-install` with
the completed bundle and `sleep 180` in one command. Sotto's restart interrupted
the tool response; the resumed thread checked the result without reinstalling.

`/Applications/Sotto.app` reports `0.1.43-owl.20261107.5`. The installer log records
`2026-11-07 19:50:56 installed 0.1.43-owl.20261107.5 and relaunched`.
The app process started at 19:50:41 and remained running after the installer's
startup check. Its deep, strict signature check passes, and its packaged
provenance matches the same source commit and all 356 local build artifacts.

A post-install key scan also included the installed app, the installer's run
folder and log, and Sotto's live Hermes home. It found zero matches across
17,864 files (3,324,929,778 bytes), with the same exclusions as above.
