# mise's Codex list stopped at 0.163.0 while 0.165.0 was published

Checked on forge on October 27, 2026, with mise 2026.9.10, after Update on forge's Codex tile said "mise does not list 0.165.0 yet" with 0.164.0 installed. npm published 0.165.0 at 20:14Z, and GitHub has the `rust-v0.165.0` release.

## What mise saw

```sh
mise ls-remote codex | tail -1    # 0.163.0
mise latest codex                 # 0.163.0
```

The first guess was mise's shared GitHub cache, `~/.cache/mise/github/openai-codex-all-releases-1068e.msgpack.z`, last written October 16, which `mise cache clear codex` leaves alone. Moving that file aside and clearing the tool's cache changed nothing. With `MISE_DEBUG=1`, `mise ls-remote codex` read neither cache. It fetched `https://mise-versions.jdx.dev/data/codex.toml`, mise's versions host, which ends at `0.164.0-alpha.12` (October 22) and lists neither 0.164.0 nor 0.165.0. That host's Claude Code and OpenCode lists were current (2.1.312, 2.2.0).

With the versions host off (`MISE_USE_VERSIONS_HOST=0`), mise asked GitHub itself for `repos/openai/codex/releases?per_page=100` and got 504 Gateway Timeout on every retry. With curl from forge, the hundred-per-page request answered 504, fifty per page took 28 s, ten took 7 s, and `releases/latest` named `rust-v0.165.0`. Claude Code's and OpenCode's hundred-per-page lists answered 200. The rate limit was not involved. A few minutes later, one hundred-per-page request answered 200, so the timeout comes and goes.

mise 2026.10.21, run from `/tmp` with its own cache, data and config folders, answered the same: `mise latest codex` 0.163.0, and nothing for `mise ls-remote codex 0.165.0`.

## What gets the version through

```sh
mise cache clear codex
MISE_MINIMUM_RELEASE_AGE=0s mise install codex@0.165.0 --minimum-release-age 0s   # installed in 60 s
codex --version                                                                    # codex-cli 0.165.0
```

mise fetched the release by its tag (`/api/github/repos/openai/codex/releases/rust-v0.165.0` on the versions host), downloaded `codex-package-x86_64-unknown-linux-musl.tar.gz`, checked it and installed it. `installs/codex/latest` moved to `0.165.0`, and `~/.local/bin/codex`, which runs `mise use -g codex` and then `mise x codex`, starts 0.165.0, since the global config asks for `latest` and mise reads that as the newest version installed. `mise ls-remote codex` still ended at 0.163.0 afterwards.

So since #1464 the list was all that stopped Update. A list without the version no longer stops the press: Sotto still clears the cache and reads the list, then installs by name (ADR-0042, October 27 amendment). The exception is a list that holds another build of the version, such as `0.165.0-alpha.3` with mise's prereleases on: mise 2026.9.10 resolves a version its list lacks against `^<version>([-.].+)?$` (`src/toolset/tool_version.rs`, `fuzzy_match_versions`) and would install that build, so Sotto refuses. With none, as for Codex today, mise installs the version as named. In a throwaway mise folder on forge, `mise install codex@0.164.0` installed stable 0.164.0 though the versions host lists only its alphas, because prereleases are off by default. `tests/unit/main/miseClientUpdates.test.ts` stands in a mise whose list never has the version, for Claude Code, Codex, OpenCode and Muse, and expects the install to run.

## Not covered

The running app was not used. Forge's Codex was installed by hand with the command above, not by pressing Update, because the host runs the update path only once it carries a build with the change. The moved GitHub cache file was not put back, because mise wrote a fresh one during the install. The throwaway mise 2026.10.21 folder was removed.
