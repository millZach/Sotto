# Attachment previews after the send - September 25, 2026

Issue #316. A send that carried an image used to write the attachment preview store before the provider heard anything. The store is one file, `attachment-previews.json`, holding up to 100 MiB of image bytes, and every such send rewrote all of it, pretty-printed and synced. Now the coordinator records the preview once `host.execute` returns and does not wait for the write. The provider hears the prompt first.

What decides whether a preview is kept has not changed. A send the provider took, might have taken, or already echoed keeps its preview. A send it refused, or one that threw, keeps nothing, and now nothing is written for it at all, so the `forget()` calls that undid the early write are gone. If the write fails after the send, the message stays sent and its preview shows as unavailable. The old failure, "The prompt was not sent", can no longer happen.

## Numbers

Median of nine sends, each carrying one 1 MiB PNG, with 0, 10 or 50 MiB of earlier previews already in the store. Times are from the moment the coordinator is handed the send. Two runs before and three after, on the development machine (Windows 11, 24 cores, Node v24.14.1), while other agents' test suites were running on it, so read them as sizes rather than budgets.

| Previews already stored | Provider hears it, before | Provider hears it, after | Provider acknowledges, before | Provider acknowledges, after |
| ---: | ---: | ---: | ---: | ---: |
| 0 MiB | 179-211 ms | 131-136 ms | 187-217 ms | 136-141 ms |
| 10 MiB | 237-315 ms | 126-133 ms | 243-321 ms | 130-140 ms |
| 50 MiB | 534-617 ms | 125-135 ms | 539-623 ms | 131-141 ms |

Before, the time to the provider grew with the store. After, it does not.

The write still happens, and it still runs on the main process. Serialising the store is synchronous, so it holds up whatever the coordinator does next. The command itself now returns at 162-176 ms, 200-215 ms and 374-401 ms for the three sizes, against 193-221 ms, 249-332 ms and 546-629 ms before. The store is back on disk 168-185 ms, 226-252 ms and 500-513 ms after admission, no later than before. What moved is the order: the prompt goes out first and the thumbnail follows.

## What these numbers are and are not

- They are Sotto's own work and the disk. The provider is the in-process E2E host, which answers at once. A real provider adds its own round trip after the point measured here, and that part is unchanged.
- The benchmark drives the real `AgentControl` and the real preview store on a temporary folder. It waits for the store to go idle between sends, as a person would.
- About 125-135 ms of every send is admission work before the provider hears it that is not the preview store. This change does not touch it and this note did not look into it.
- "Before" is `src/main/agents/control.ts` and `src/main/agents/attachmentPreviews.ts` from `origin/main` at `242af9b1`, checked out in place for the run, with the same benchmark.
- The store is still one file rewritten whole. Phase 3's attachment handles replace it with one file per entry; the pretty-print was left as it is.

## Re-run

```sh
SOTTO_PERF_PREVIEW_SEND=1 npx vitest run tests/perf/previewSend.perf.test.ts --reporter=verbose --silent=false
```

It is skipped without the variable. Each line it prints is timers only: nothing about the prompt or the image is recorded. The behaviour is pinned in `tests/unit/main/attachmentPreviews.test.ts`, including a refused send that writes nothing to the preview store.
