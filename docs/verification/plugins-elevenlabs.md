# An ElevenLabs account on the Plugins page

Checked on Windows on November 15, 2026, in the built app, for #2498, the first part of slice 12 of
`docs/plans/2026-11-11-plugins.md`. Zach picked on November 15, 2026, from the prototype kept as the tag
`prototype/elevenlabs`:
- ElevenLabs makes speech, sound effects and music as files in a thread's folder.
- A finished sound is a quiet line in its thread, as a 3D model's is.
- The monthly limit starts at $10, at ElevenLabs' published API prices.
- The agent picks a voice by name.
- Images and video stay with Higgsfield.

This part is the account alone. Threads cannot make a sound with it yet.

ElevenLabs was a stand-in: a small server on this computer that answers `GET /v1/user/subscription` for one made-up key
and 401 for anything else. The run is `tests/e2e/plugins-elevenlabs.spec.ts`, with `SOTTO_OWL_FEATURES=plugins=1`, and
the stand-in's address given by `SOTTO_E2E_ELEVENLABS_API_URL`, which a packaged build never reads. Nothing reached
ElevenLabs.

## What was done

ElevenLabs' row sits under Meshy in **3D, sound and video**, with its two bars for a mark, and reads "Not added".
Opened, the row says:
- that ElevenLabs makes speech, sound effects and music as files in a thread's folder;
- that Sotto keeps the key and makes each request itself;
- that nothing plays until you press Play;
- that ElevenLabs may use what it is sent to train its own models, unless that is turned off under Data use in the
  ElevenLabs account.

**Add an ElevenLabs account** asked for a name and an API key, made at elevenlabs.io/app/settings/api-keys. A key the
stand-in refuses got "ElevenLabs did not accept this key. Nothing was saved. Check the key at
elevenlabs.io/app/settings/api-keys. A restricted key must be allowed to read your account."

The good key was kept: the account read "API key saved November 15." and the folded row "ElevenLabs, Voices". The
stand-in was asked only `GET /v1/user/subscription`, once for each key, and that read makes nothing. Afterwards the key
was not in the page, and neither key was in any file in Sotto's data folder.

Under **What it spends**, **Ask before each sound** was on and **Monthly limit in US dollars** read 10. No count of the
month's spending is shown yet, since nothing spends through the account until threads make sounds. The open row was
checked in dark and light at 1600x1000, 1280x800 and the 820x560 minimum, and nothing was wider than its room.

![The account at 1280x800](../../artifacts/plugins-elevenlabs/elevenlabs-account-dark-1280x800.png)

![The account in light](../../artifacts/plugins-elevenlabs/elevenlabs-account-light-1280x800.png)

![The account at the minimum size](../../artifacts/plugins-elevenlabs/elevenlabs-account-dark-820x560.png)

Turning the switch off and setting the limit to 25 with Enter saved both: the account read back as asking off, $25.

![After the change](../../artifacts/plugins-elevenlabs/elevenlabs-spending-changed-dark-1280x800.png)

Meshy's account journey (`plugins-meshy.spec.ts`) still passes with the new row beside it.

## What else covers it

- `tests/unit/main/plugins/elevenLabsAccount.test.ts`:
  - the key is checked by reading the subscription, in the `xi-api-key` header, with no redirect followed;
  - 401 and 403 are refused, 429 is busy, and anything else could not be checked;
  - a key with a line end is sent nowhere;
  - the account starts at asking on and $10, Meshy's stays 1,000 credits, and the record is version 6, which builds
    from before ElevenLabs refuse;
  - its switch and limit change.
- `tests/unit/main/plugins/copySync.test.ts`, `accountCopies.test.ts` and `tests/integration/pluginAccountCopies.test.ts`:
  - a host from before ElevenLabs is sent no copy, and the page says it is too old;
  - a current host lists `plugin-elevenlabs-copies` only to the desktop the launch script recorded, keeps the copy, and
    lists its switch and limit back.
- `tests/unit/renderer/features/settings/pluginsSettings.test.tsx`:
  - the row, its words and the add form;
  - the switch, and the limit in whole dollars;
  - no credits read for the account.

## Not checked here

- A real ElevenLabs key. The check was run against the stand-in only.
- Making a sound, the card that asks, the line in the thread, and a host's threads using the copy. Those come with the
  slice's later parts.
