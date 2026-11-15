# Spark's thinking levels in Hermes

## Behavior

This change builds on the add-an-API work in #2414. After **Check again** for
Spark Cluster, its DeepSeek V4.1 models offer **Off, Low, High and Max** beside
the model in new and existing Hermes threads. High is the initial choice.
OpenCode receives the same confirmed levels. The existing effort picker renders
the choices; no new screen or control is introduced.

Discovery requires both `model_type: deepseek_v41` and
`reasoning_parser: deepseek-v41` from SGLang's `/model_info`. Each model must be
the reported `served_model_name` or name that model in its model-list `root`.
Explicit model-list `reasoning_options` win. Unknown encoders, unmatched model
entries and unavailable metadata receive no guessed levels.

Reading an existing saved record does not change it. Check again saves the
discovered levels through the existing record and adapter notification path,
preserving the chosen models and keeping unchosen models out of the menu.

## Running server evidence

Checked November 10, 2026 against the owner's Spark endpoint at
`http://10.0.0.115:8888/v1`. No configuration was changed and the server was not
restarted. The running container was `dsv41-head`, image
`dsv41-4x-spark:knap25s`; its reported SGLang version was
`0.0.0.dev1+gda64c5cbb`.

The live model list had six aliases rooted at
`DeepSeek-V4.1-Flash-1017-UNCENSORED`. It reported context 1,048,576 and no
`reasoning_options`. `/model_info` reported the V4.1 type and parser above,
`DeepseekV4ForCausalLM`, and image support.

Read and executed the installed request normalizer and encoder inside that
container, without loading another model or issuing an inference request:

| Request `reasoning_effort` | Normalized thinking | Encoder instruction |
| --- | --- | --- |
| `none` | Both thinking toggles false | No reasoning-effort prefix |
| `low` | Both thinking toggles true | Reasoning Effort: 50 |
| `high` | Both thinking toggles true | Reasoning Effort: 75 |
| `xhigh` | Both thinking toggles true | Reasoning Effort: 75 |
| `max` | Both thinking toggles true | Reasoning Effort: 100 |

The running image's adapter changes SGLang's on-disk default table. Inspecting
the file alone gives the wrong budgets: the imported module has Low 50, High 75,
XHigh 75 and Max 100. Its configured default is budget 75. XHigh duplicates High,
so the confirmed profile does not offer a separate XHigh stop.

The installed Hermes custom provider's `build_api_kwargs_extras` was also
executed, using Sotto's existing Python environment. For each of `none`, `low`,
`high` and `max`, it returned the same top-level `reasoning_effort` and no extra
body fields. Thus Off reaches SGLang's request normalizer as `none`; it is not
passed directly into the encoder's numeric effort table.

## Checks

The regression test failed before the discovery change: all six saved aliases
had `['default']`. It then passed with the four confirmed levels, saved-record
round trip, preserved selection, adapter notification, Hermes High default,
and OpenCode declarations. Negative cases cover the wrong parser, wrong model
type, missing loaded-model binding, an unrelated listed model and explicit API
levels.

All commands below ran from this worktree. Each test file ran separately:

- `npm run typecheck`: clean.
- `npm run lint`: clean.
- `npm run notices:verify`: 200 components verified.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/main/ownModelServers/sglangEffort.test.ts`: 6 passed.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/main/ownModelServers/check.test.ts`: 24 passed.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/main/hermesModels.test.ts`: 2 passed.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/main/hermesSessionEffort.test.ts`: 3 passed.
- `fnm exec --using=v24.22.1 npx vitest run tests/unit/renderer/agents/threadEffort.test.tsx`: 20 passed.
- `SOTTO_SGLANG_EFFORT_URL=http://10.0.0.115:8888/v1 fnm exec --using=v24.22.1 npx vitest run tests/integration/sglangEffortLive.test.ts`: 1 passed.

No Sotto app launch, visual capture or inference-quality measurement was run.
The installed app and its saved configuration remain unchanged; both #2414 and
this follow-up need to ship before the owner can use Check again for the slider.
