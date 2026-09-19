# Screenshot support across models

September 19, 2026. Local Windows build; not installed or released.

## Acceptance

- [x] Codex models advertising image input allow screenshots, including future model names.
- [x] Codex follows every model catalog page, including image-capable models on later pages.
- [x] Claude screenshot-only sends contain image blocks without an invalid empty text block.
- [x] Every Claude catalog model, including an unknown future entry, accepts screenshots.
- [x] Grok client limitation verified from native initialization; unsupported sends fail before dispatch.
- [x] Older catalogs without input modalities use Codex's documented image-capable default.
- [x] Explicit text-only models remain blocked before any native send.
- [x] Send and steer include actual image inputs, including image-only prompts.
- [x] Image references survive history refresh, changed native item IDs, reconnect and uncertain delivery without duplicate sends.
- [x] Maximum 20 MiB input and accumulated screenshot history remain connected.
- [x] Native image-only input remains takeover evidence, including rollout rows over 1 MiB.
- [x] Shared Electron composer: paste, preview, image-only send and queued screenshots.
- [x] Visual inspection: light and dark, reduced motion, 1600x1000, 1280x800 and 820x560.

## Cause and fix

`CodexAppServerHost` marked every discovered model `supportsImages: false`. Both send and steer validated attachments but constructed only text and skill inputs. The initial regression command, `npx vitest run tests/unit/main/codexHost.test.ts -t 'allows a screenshot' --maxWorkers=2`, failed with `This model does not advertise image support` before the fix and passed afterward.

The adapter now reads `inputModalities`, sends validated data URLs as native image inputs, and retains attachment references in message origins. Preview bytes stay in the existing Sotto preview store; no image bytes or prompt text are added to adapter logs or origin records. Claude image support stays enabled for every catalog entry. Screenshot-only Claude sends now omit the empty text block that was previously appended after image blocks.

The installed Codex 0.155.1 generated schemas confirm the model modality default and native image input shape. The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) specifies the same compatibility default. A read-only `initialize` / `model/list` check against the installed native App Server also returned image-capable entries for GPT-6 Astra, GPT-5.6 Sol, Terra, Luna and GPT-5.5. No thread or paid model turn was created.

Independent review found two additional gaps: a single-batch frame budget could reject accumulated image history, and the rollout reader's 1 MiB partial-line limit could discard native image-only takeover evidence. Both were fixed and the reviewer found no remaining issues on recheck. Stdout and rollout rows accumulate in linear time. Legacy whole-history frames remain bounded at 128 MiB, with a 256 MiB queued-frame limit; larger histories still require future pagination work.

## All-model audit

The follow-up audit found that Codex listed only its first catalog page. It now follows `nextCursor` and publishes the complete catalog, retaining each model's reported modalities. A regression first failed because an image-capable model on page two was absent. Repeated cursors fail the catalog read instead of looping or publishing partial results.

Claude's native model catalog already enables images for every entry; the [Anthropic model overview](https://platform.claude.com/docs/en/models/overview) confirms image input support. A new regression reproduced screenshot-only native content with an invalid empty text block. The fix omits that block. Catalog tests cover Default, Sonnet, Opus, Haiku and an unknown future entry; transport tests cover captions, cold reconnect, duplicate prevention and 20 MiB batches.

A read-only `initialize` against the installed Grok CLI 1.0.5 returned `promptCapabilities.image: false` with Grok 4.6 and Grok 4.5 in its catalog. No authentication, session creation or paid turn was requested. [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization) requires that capability for image prompt blocks. Grok screenshots therefore remain unavailable through this client, regardless of the underlying model's vision capability. Enabling them requires a native client with verified image transport. The negative integration check confirms Sotto rejects the attachment before any `session/prompt`, so it cannot silently discard the screenshot.

## Validation

- Typecheck, lint, build and third-party notices passed on the final changes.
- Independent follow-up standards and spec review found no remaining findings in catalog pagination or Claude image-only transport.
- Codex regression, session log, host, target log and message identity suites: 67 tests passed after the initial review fixes. The all-model follow-up passed all six Codex image tests and 45 Claude image, adapter, safety and transcript tests.
- Final Electron build: both screenshot paste/send/queue and independent image draft/navigation/restart tests passed.
- Full CI-equivalent suite: `npm test -- --maxWorkers=2` passed 3,762 tests across 286 files; 31 tests in 17 files skipped. The run set `SOTTO_PERF_DATA` to an empty isolated directory, so private-workspace benchmarks skip as they do in CI. Output: `artifacts/codex-images/all-models-full-suite.log` (437.46 seconds, final all-model changes).
- A prior run against the installed profile hit two unrelated performance benchmark failures because that profile has empty inline message arrays. That run also began before the review fixes were complete; the fresh final run above is the acceptance result.

The Electron checks exercise the real shared composer with the deterministic in-memory provider. Provider-specific protocol checks use the real Codex and Claude adapters against child-process fake providers, including a 20 MiB batch, later screenshot turns, steering, lost acknowledgements and restart. These checks do not establish live provider image interpretation or macOS behavior.

## Captures

Generated under `artifacts/codex-images/` (ignored):

- `pasted-1600-dark.png`, `pasted-1600-light.png`
- `pasted-1280-dark.png`, `pasted-1280-light.png`
- `pasted-820-dark.png`, `pasted-820-light.png`
- `sent-and-queued.png`

The pasted preview and send button are visible at the minimum size. Screenshot-only send produces the transcript preview; the next queued message retains its image reference. The test dispatches a browser clipboard event with a PNG file and does not overwrite the user's operating-system clipboard.
