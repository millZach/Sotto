# mise's stale version list held back a client update

Checked on forge on October 23, 2026, with mise 2026.9.10, after Update on forge's Claude Code tile reported that Claude Code still ran 2.1.309 when 2.1.310 was published. Nothing on forge was upgraded: every install below ran with `MISE_DATA_DIR` and `MISE_CACHE_DIR` in throwaway folders under `/tmp`, removed afterwards. The host's own output goes to `/dev/null`, so the press itself left no log; the steps below reproduce it.

## What mise saw

GitHub published `v2.1.310` at 23:39Z, and npm's `latest` tag named it. At 23:51Z on forge:

```sh
MISE_MINIMUM_RELEASE_AGE=0s mise upgrade claude --minimum-release-age 0s --dry-run   # "All tools are up to date", exit 0
mise ls-remote claude 2.1.310                                                          # nothing
```

`~/.cache/mise/claude/remote_versions-*.msgpack.z` was written at 23:01Z (an hour's cache) and ended at 2.1.309, as did mise's cached lookup of GitHub's newest release. Sotto's update ran that same `mise upgrade`, which exits 0 without installing, so Sotto reported the version had not moved.

Codex and Muse showed the same lag that evening: `mise latest codex` said 0.163.0 with 0.164.0 installed, and Muse's stable feed named 1.4.12-R6909.1 while mise had 1.4.11-R6667.1.

## What gets the version through

On a copy of forge's cache:

```sh
mise cache clear claude                                            # "mise cache cleared for claude"
MISE_MINIMUM_RELEASE_AGE=0s mise ls-remote claude 2.1.310          # 2.1.310
MISE_MINIMUM_RELEASE_AGE=0s mise latest claude                     # still 2.1.309
MISE_MINIMUM_RELEASE_AGE=0s mise upgrade claude --dry-run          # still "All tools are up to date"
mise install claude@2.1.310 --minimum-release-age 0s               # installed in 40 s, exit 0
```

After the install, `installs/claude/latest` linked to `2.1.310`, and `mise ls claude` showed 2.1.310 as the version the global config's `latest` asks for. Installing 2.1.309 afterwards left `latest` on 2.1.310, so the link follows the newest version installed, not the last one. `mise install`, `mise ls-remote` and `mise upgrade` all take `--minimum-release-age`.

So Update now runs `mise cache clear <tool>`, `mise ls-remote <tool> <version>` and `mise install <tool>@<version>` (ADR-0042, October 23 amendment). `tests/unit/main/miseClientUpdates.test.ts` stands in a mise whose lists stay stale until the tool's cache is cleared, for Claude Code, Codex, OpenCode, Muse and Grok Build.

## Not covered

The running app was not used: the change is in the host's update path, which a host only runs once it carries a build with it. The hourly `mise-agent-clis-upgrade` timer on forge is the owner's own configuration, not Sotto's, and was left as it was.
