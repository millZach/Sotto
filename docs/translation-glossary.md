# Translation glossary

What a translation of Sotto's interface follows (ADR-0122). The catalogs are `src/locales/<area>/<language>.po`, one per area of the tree (`lingui.config.ts` lists them); English is the source and `npm run i18n:extract` writes every catalog. A draft is a model's until a native speaker reviews it, so keep drafts plain enough to review.

## How Sotto sounds

- Short sentences in the glossary's nouns, no marketing. A control's name says what a press does. An error says what happened, whether anything was lost and what to do next.
- Address the reader the way that language's own operating system does. The first catalogs use `tú` in both Spanishes, `vous` in French, `du` in German, Swedish, Danish and Norwegian, `tu` in Italian and Romanian, `você` in Brazilian Portuguese and the third person in European Portuguese, `je` in Dutch, `ty` in Polish, `vy` in Czech, `ви` in Ukrainian, `te` in Hungarian and `sinä` in Finnish, the polite plural in Greek, `siz` in Turkish, `آپ` in Urdu, `आप` in Hindi, `तुम्ही` in Marathi, `আপনি` in Bengali, `మీరు` in Telugu and `நீங்கள்` in Tamil. Japanese uses です and ます; Chinese stays neutral.
- Keep the English message's shape: a label stays a label, a sentence stays a sentence with its full stop. Keep the ellipsis on a command that opens something (`Settings…`).
- Placeholders (`{name}`, `{count}`) keep their names exactly; move them where the language needs them. Plurals use that language's own categories (`one`, `few`, `many`, `other`; Arabic also `zero` and `two`; Chinese and Japanese only `other`), and `#` is the number.
- Numbers, percentages and dates are formatted by the app in the reader's language; don't write them into a message.
- An empty translation shows in English. Leave a message empty rather than guess.

## Never translated

Sotto, Sotto Owl, Owl, Watcher, Muse, Claude Code, Claude bot, Codex, Grok Build, Devin, OpenCode, OpenCode Zen, OpenRouter, Parakeet, Parakeet Ultra, Tailscale, GitHub, Git, git, gh, the theme names (Sotto, Hush, Linen, Nocturne, Tropic, Citrine, Omarchy), Windows, macOS, Linux, iPhone, and anything in code type: commands, paths, branch names, keys and setting ids. Add the grammatical endings a name needs (`Sotto’yu`, `Sotto-வை`) without changing the name.

## Sotto's nouns

Translate each of these the same way everywhere in a language. `CONTEXT.md` says what each means; the column is the draft each catalog uses until a reviewer changes it here and in the catalogs together.

| English | Means | es-MX / es-ES | fr | de | pt-BR / pt-PT | ja | zh-Hans / zh-Hant | ar |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| thread | one conversation with one coding agent about one project | hilo | fil | Thread | conversa | スレッド | 会话 / 對話 | محادثة |
| project | a working folder a thread belongs to | proyecto | projet | Projekt | projeto | プロジェクト | 项目 / 專案 | مشروع |
| host | the process that owns the providers, on this computer or another | host | hôte | Host | host | ホスト | 主机 / 主機 | المضيف |
| provider | the installed client that runs a thread's agent | proveedor | fournisseur | Anbieter | provedor / fornecedor | プロバイダー | 提供方 / 供應商 | المزوّد |
| agent | what a provider runs | agente | agent | Agent | agente | エージェント | 智能体 / 代理程式 | الوكيل |
| dictation | speaking into Sotto to type | dictado | dictée | Diktat | ditado | 音声入力 | 听写 / 聽寫 | الإملاء |
| theme | a named palette | tema | thème | Design | tema | テーマ | 主题 / 主題 | السمة |
| creature | the pixel character above the composer | criatura | créature | Kreatur | criatura | キャラクター | 小角色 | المخلوق |
| Settings (the page, the menu item) | | Configuración / Ajustes | Réglages | Einstellungen | Configurações / Definições | 設定 | 设置 / 設定 | الإعدادات |
| Appearance (Settings page) | | Apariencia | Apparence | Erscheinungsbild | Aparência / Aspeto | 外観 | 外观 / 外觀 | المظهر |
| Preview (the mark on a feature still being drafted) | | Vista previa | Préversion | Vorschau | Prévia / Pré-visualização | プレビュー | 预览 / 預覽 | معاينة |
| effort (a model's reasoning level) | | esfuerzo | effort | Aufwand | esforço | 推論レベル | 推理强度 / 推理強度 | الجهد |

The other twenty-one languages follow the same rule from their first catalog: the word the first draft chose for each noun is the word every later message uses. A reviewer who changes one changes it in every catalog of that language in the same pull request.

The Settings page names other than Appearance (Dictation, Cleanup, Threads, Git & worktrees, Watcher, Providers, Hosts & phones, Cloud iPhone, Application, Performance) are translated with the Settings area. Watcher stays Watcher; Cloud iPhone keeps `iPhone`.
