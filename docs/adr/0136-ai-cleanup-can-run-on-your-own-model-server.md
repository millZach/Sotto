# AI cleanup can run on your own model server

## Status

Accepted October 25, 2026, at Drake Morey's request, as an Owl feature (`own-server-cleanup`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It amends [ADR-0124](0124-your-own-model-server-is-a-model-source.md), whose closing line put AI cleanup on a user's server out of scope, and its decision 5 on when Sotto itself contacts a server. On Owl it extends [ADR-0122](0122-the-cleanup-model-can-be-chosen-on-owl.md): the cleanup model may be a model on one of the user's own servers. Stable keeps ADR-0069 whole. **Number provisional until merge** (docs/agents/domain.md): 0135 is held by an open pull request.

He asked for dictation to be cleaned up on his DGX Spark cluster, which Sotto already runs threads on, with Sotto finding the fastest settings for that server by measuring rather than by asking him. He chose the picker (a section in the existing Cleanup model list, no separate switch), Mercury 2 as the backup, and Mode not applying to his own models.

## Context

ADR-0122 lets someone on Owl choose any OpenRouter model to clean up dictation. ADR-0124 lets them add servers they run, which OpenCode drives as a model source for threads. A server on the user's own network can answer a short cleanup faster than a round trip to OpenRouter and keeps the text in the house, but every server, model and serving stack handles thinking differently: SGLang and vLLM read a chat template switch, Ollama and LM Studio read `reasoning_effort`, and a model that thinks by default can spend more time thinking than cleaning up. ADR-0069 found that turning thinking off cut some transcripts short on one model. Sotto cannot know which setting a server honours without trying it.

## Decision

1. **The Cleanup model list gains a Your own servers section,** above OpenRouter's models and below Default, listing the models of every server added in Settings › Providers › Your own model servers. Picking one saves it as `llmOwnModel` (the server's and the model's saved IDs), which wins over `llmModel` while the feature runs; `llmModel` is kept, so with the feature off the OpenRouter choice from before cleans up again. Picking an OpenRouter model or Default clears `llmOwnModel`. There is no separate switch. Mode is hidden while one is chosen, since OpenRouter's routing does not apply to it; the saved mode is kept.

2. **Only a server added without a key can clean up.** OpenCode keeps a server's key and Sotto keeps none (ADR-0124 decision 3), so main has nothing to send. A server added with a key is not listed, and the list says why. Keeping a copy of the key in Sotto's credential store would be a second key, which is a product decision ([AGENTS.md](../../AGENTS.md), "One key"), so it waits until someone asks for it. A server Sotto reaches over plain http is still only a private one (ADR-0124 decision 4).

3. **Sotto measures, on the user's press only.** Picking a model, and **Measure again** beside it, runs Measure: a fixed built-in sample transcript of about seventy words, never anything the user said, is cleaned up on the server with each candidate setting in turn, one request at a time. The candidates are: nothing about thinking (the model's own default); the chat template's thinking switch off (`chat_template_kwargs` with `enable_thinking` and `thinking` false); and the least effort (`reasoning_effort: low`). Every request is at temperature 0 with an answer limit of three tokens a word plus 128, which a cleanup never needs and a model that thinks at length runs out of. Each candidate is tried twice. A try passes only if the answer finished, passed the shrink guard in `cleanupOutput.ts`, and kept words from the start, middle and end of the sample; a candidate passes only if both tries did, and its faster try is its time. The fastest passing candidate is kept per server and model in `own-server-cleanup.json` under Sotto's user data, and Settings shows it ("Fastest: thinking off, 0.4 s"). A server that refuses a candidate's field only loses that candidate. When none passes, Settings says so and cleanup goes straight to Mercury 2. When nothing answered, nothing is decided and the last measure stands.

4. **A cleanup runs with what was measured.** The transcript goes to the server's `/chat/completions` with the user's dictionary in the prompt, as it would to OpenRouter, with the measured thinking setting, temperature 0 and the same answer limit, and no redirect followed. A model not yet measured is sent nothing about thinking.

5. **The server gets three times its measured time before Mercury 2 takes over,** scaled to the transcript's length against the sample's and never under 1.5 seconds, and never more than a chosen OpenRouter model would get of the deadline. A server three times slower than when it was measured is having a bad moment, and Mercury 2, at about 0.4 seconds, still fits in what is left. A model not yet measured gets the same share as any chosen model.

6. **Mercury 2 is the backup, as in ADR-0122.** A server that fails, runs long, was removed, no longer has the model or was given a key since hands over to Mercury 2 on OpenRouter, so dictation never waits on the server. The OpenRouter key is still needed for AI cleanup to run at all, since the backup needs it and the Cleanup page sits under it.

7. **Its own Owl entry, on top of the two it builds on.** `own-server-cleanup` runs only while `cleanup-model` and `own-model-servers` also do and Your own model servers exists on this run (OpenCode not held, the local host on). A separate entry lets Zach send it to stable on its own: without it, it would reach stable the moment both parents did, though it sends dictation somewhere neither of them does. Off, main registers no channel and passes the cleanup pass no server, the list shows no section, and the saved choice and measures are kept, so turning it on restores them.

8. **Nothing about it is logged but stable event names.** Measure logs `own-server-cleanup-measured` or `own-server-cleanup-measure-refused`. The cleanup diagnostic records the first model as `own-server`, never the server's name, address or model.

This amends ADR-0124 decision 5: Sotto itself now contacts a server when the user presses Check, Add, Check again or Measure again, picks a model as the cleanup model, and, while that model is chosen, on every dictation that AI cleanup runs on.

## Consequences

The README's privacy section names a new destination for dictation text: the user's own server, which whoever runs it can read. Audio still never leaves the computer.

The candidate fields are those SGLang, vLLM, Ollama and LM Studio document for their OpenAI-compatible endpoints; they were not checked against each server's current docs or a live server when this was written. A stack that reads thinking some other way gets its default from the plain candidate, which is always tried.

The measure is a snapshot. A server whose load changes, or a model swapped under the same name, keeps the old answer until the user measures again; the three-times allowance and the fallback cover a slower day.

Changing the candidates or the sample is a change to `src/main/llm/ownServerCleanup.ts` and an amendment here.
