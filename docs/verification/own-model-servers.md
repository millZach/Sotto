# Your own model servers

Checked on Windows on October 23, 2026, for #1426 (ADR-0124), in two halves: the built app with Owl features on over Sotto's stand-in OpenCode (`tests/fixtures/fakeOpenCodeServer.mjs`) and a stand-in SGLang server on 127.0.0.1, and Sotto's own code against the real OpenCode 2.1.4 and a fake OpenAI-compatible server. Zach picked layout B with C's model menu entry from `prototype/local-model-server`.

## What was done

**In the built app** (`tests/e2e/own-model-servers.spec.ts`): Settings › Providers showed **Your own model servers** above the provider tiles. **Add a server** with an address where nothing listens said "Nothing answered at 127.0.0.1:9. Nothing was saved." with what to do next, and left the fields as typed. Against the stand-in SGLang server, **Check this server** said "SGLang answered … with 2 models": one with its context read from the server (`max_model_len`), one the server did not size, whose context field asked to be typed before **Add server** would go. The server was added, then checked again and removed from its row. In a thread's composer, OpenCode's model sources ended with **Your own server…**, which opened the same dialog. It was checked in dark and light, at 1280x800 and at the 820x560 minimum; nothing clipped, and the lowest text contrast measured was 6.06:1.

**Against the real client** (`tests/integration/opencodeOwnServersLive.test.ts`, run with `SOTTO_OPENCODE_LIVE=1`, 65 s): the service added a server without a key, and OpenCode 2.1.4 listed its models under the server's name, as `own-…/<model>`. A key given at Add went through `connect/key`, and the next chat request carried it in place of the placeholder. A model with Thinking off had no effort levels; with it on, low, medium and high, and OpenCode sent `reasoning_effort`. Remove signed the source out and took the models away.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/own-model-servers/dialog-checked-1280-dark.png` | A checked SGLang server: one context read from it, one to type |
| `artifacts/own-model-servers/dialog-unreachable-1280-dark.png` | Nothing answered: what happened, nothing saved, what to do |
| `artifacts/own-model-servers/group-added-820-light.png` | The group with a server added, light, at the minimum window |
| `artifacts/own-model-servers/menu-own-server-1280-dark.png` | **Your own server…** at the end of OpenCode's model sources |
| `artifacts/own-model-servers/dialog-from-menu-820-dark.png` | The same dialog opened from the model menu, at the minimum |

## Not checked here

- A thread's turn on a real model. The stand-in OpenCode in the built app did not read `OPENCODE_CONFIG_CONTENT` at the time, so the added server's models did not reach its model menu there; the live test covers that half. It reads it since phase 2 (`own-server-turn-errors.md`). A real run against Ollama or the Sparks waits for a server Zach can reach.
- macOS and Linux.
- Pinned OpenCode 2.0.31, which was not on this computer; its source for everything used here is the same as 2.1.4's (`docs/plans/local-inference.md`).
