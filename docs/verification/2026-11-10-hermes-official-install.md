# Hermes's official installer — November 10, 2026

Based on `origin/main` at `822a6cb20`. The installed Hermes is 0.23.1,
upstream `3b4215785882`, installed by its official installer. No Sotto app was
launched, built or installed for this check. No existing Hermes home was used
to run a command, repaired or updated.

## Reproduced outside Sotto

With a new temporary `HERMES_HOME`, the installed `~/.local/bin/hermes --version`
exited 1 with `no dependency environment is committed for this install` and
advised `hermes pm repair`. The published `--print-runtime-command` returned
store Python, isolated mode and the bootstrap that activates dependencies.

The public command is a shell script, not a symlink. The existing helper's
`~/.local/bin/python -c ...` failed with ENOENT: no Python lives beside that
launcher. No gateway was needed to reproduce that missing executable.

## Revised runtime outside Sotto

A standalone Node bundle of Sotto's actual `HermesRuntime` and
`readHermesVersion` ran against the installed launcher. It used a second
temporary home with a copy of the installed dependency venv and a temporary
`facts.json` pointing only to that copy. This avoided another package download
and did not change the original dependency environment. It tests runtime use
after packages are present, not `pm repair` itself.

- Version read: **0.23.1**.
- Gateway readiness helper through `hermes --run-module timeit --number 1
  --repeat 1`: **passed**.
- Project profile write and profile rescan helper: **passed**.
- Gateway ownership record before and after the rescan: **unchanged**.
- A deliberately failing statement through the same launcher returned exit 1.
- The gateway was stopped and awaited in the probe's `finally` block.
- No model prompt or key was sent; the configuration used a dummy loopback
  address. Temporary homes and the standalone bundle were removed afterwards.

## Focused checks

- `npm run typecheck` and `npm run lint`: passed.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/main/hermes.test.ts`:
  7 passed.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/main/hermesEnvironment.test.ts`:
  13 passed. Fakes cover venv and official layouts, bare and full PATHs,
  readiness and rescan invocation, both helper failures, and the missing-package
  error with a shell-quoted repair command. No repair runs automatically and
  private diagnostics are not exposed.
- `npm run i18n:extract`: completed; all changed Settings catalogs are included.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/shared/interfaceCatalogs.test.ts`:
  4 passed.

The API-provider wording was checked against `ownServerAddress`, the keyed add
in `OwnModelServers`, `hermesServers` and `hermesConfig`. Public HTTPS addresses
are accepted, the key goes to Hermes, and its config keeps the address with
`api_mode: chat_completions` and `key_env`. The existing Hermes unit test covers
a keyed public HTTPS address. No API service was contacted; this is a wording
change to an existing capability.

## Still owed

- [ ] In-app Connect from a fresh Hermes folder shows the repair command;
  after the user runs it, Connect succeeds.
- [ ] A real in-app thread opens, a second project joins the same gateway,
  and reconnect resumes its thread.
- [ ] UI text fits in Settings at the supported sizes and themes.
- [ ] A live venv install still works; its unchanged execution path is covered
  here by fakes and by the earlier November 7 native verification.
- [ ] Dependency setup after a future Hermes update, if needed.

The full suite, Playwright, design captures and packaging were left to GitHub
CI at Drake's request. No local pass is claimed for them.
