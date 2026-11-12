# Vercel accounts on the Plugins page

Checked on Windows on November 12, 2026, in the built app, for #2488: the third slice of
`docs/plans/2026-11-11-plugins.md`. Vercel is the first plugin with a secret. Its row on Settings › Plugins adds, replaces
and removes accounts, each a name and a token kept in the credential store. ADR-0205 records the decision, and its
November 12 note says how a Vercel read is held.

Vercel was a stand-in: a small server on this computer that says who one made-up token belongs to and refuses any
other. The run is `tests/e2e/plugins-vercel.spec.ts`, with the Owl feature turned on by `SOTTO_OWL_FEATURES=plugins=1`
and the stand-in's address given by `SOTTO_E2E_VERCEL_API_URL`, which a packaged build never reads. Nothing reached
Vercel, and no real token was used.

## What was done

Vercel's row read "Not added". It was opened and **Add a Vercel account** pressed; focus went to Name. With the name
Work and a token the stand-in refuses, Enter gave "Vercel did not accept this token. Nothing was saved. Make a new token
at vercel.com/account/tokens and paste it here.", and the form stayed with the name still in it.

With the token the stand-in accepts, the form closed and the account showed: "Work", "Signed in to Vercel as
example-user. Token saved November 12.", **Replace**, **Remove** and its Recent use. The folded row read "Vercel, Work".
The token was not in the page after that. The stand-in had been asked twice, each `GET /v2/user`.

The open row was checked in dark and light at 1600x1000, 1280x800 and the 820x560 minimum. Nothing on it was wider than
the room it sits in at any of the six.

**Replace** opened a field of its own with focus in it; Escape cancelled it, left the row open and put focus back on
Replace. Then every `.json`, `.log`, `.txt` and `.jsonl` file under the profile's data folder was read: neither token
was in any of them, and `plugin-accounts.json` held the account's ID, name, plugin, day saved and Vercel's name for it,
and nothing else.

**Remove** asked first: "Remove Work? Its token is deleted from this computer, and threads lose the account at once.
Nothing changes at Vercel." **Remove account** took the account away, the row read "Not added" again, and the record of
accounts was empty.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/plugins-vercel/vercel-token-refused-dark-1280x800.png` | The add form after Vercel refused a token |
| `artifacts/plugins-vercel/vercel-account-dark-1280x800.png` | The account once added, dark |
| `artifacts/plugins-vercel/vercel-account-light-1280x800.png` | The same in light |
| `artifacts/plugins-vercel/vercel-account-dark-1600x1000.png` | The same at 1600x1000 |
| `artifacts/plugins-vercel/vercel-account-dark-820x560.png` | The same at the minimum window |
| `artifacts/plugins-vercel/vercel-remove-asks-dark-1280x800.png` | Remove asking first |

The row's colours come from theme roles in `src/renderer/src/features/settings/plugins.css`, which `themeTokens.test.ts`
and `scaleTokens.test.ts` check. Vercel's icon is its own mark in the theme's text colour.

## Not checked here

- **The real Vercel.** Nothing here asked `api.vercel.com`. What its pages say was read on November 12 and is in
  ADR-0205's note of that day, with what could not be confirmed. The first real check is Zach pasting a token of his own.
- **A read by an agent.** No provider client was run. `tests/unit/main/plugins/vercelRead.test.ts` covers the read
  against a stand-in: the address, the token in the header alone, the refused paths, the fields taken out of an answer,
  a redirect not followed, and a token Vercel will not take. `pluginTools.test.ts` covers the tool an agent calls.
- **Where the token is kept.** The run shows it is in no readable file. That it sits encrypted in `credentials.json` is
  the credential store's own behaviour, tested where that store is.
- **macOS and Linux.** The spec runs on Windows only, as the other Settings specs do.
- **A paired host.** A host's threads do not get plugin tools or accounts yet; that is slice 7 (#2492).
