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

The local build target is `0.1.43-owl.20261107.5`; installation waits for Drake's
question-card choice.
