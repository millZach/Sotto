# How other coding apps change model, effort, speed and permissions from the composer

October 30, 2026, for the iPhone thread composer's settings (the prototype is `docs/prototypes/iphone-thread-settings-prototype.html`). Read from official docs on this date and from T3 Code's source at commit `80a2351`. No screenshots were seen, so what a control looks like comes from doc text or code alone.

## Claude Code

- **iPhone (Claude app, Code tab).** Permissions are behind the prompt box's **+** button, then **Permission**: Accept edits, Plan and Auto for cloud sessions, Manual added for Remote Control; Bypass permissions is never offered on the phone ([permission modes](https://code.claude.com/docs/en/permission-modes), [mobile](https://code.claude.com/docs/en/mobile)). The docs name a model control and an effort control that apply to the current session, but not where they sit or what they open ([remote control](https://code.claude.com/docs/en/remote-control)). No fast mode toggle is documented on the phone; `/fast on` works as text ([fast mode](https://code.claude.com/docs/en/fast-mode)).
- **Web.** Permissions are a mode dropdown in the row under the prompt box. Fast mode is a switch inside the model menu, shown only where the plan and model offer it.
- **Desktop app.** The model picker sits toward the right of the row under the prompt box, and effort is chosen inside it under **Effort**. Permissions are a separate selector in the same row ([desktop](https://code.claude.com/docs/en/desktop)).
- **CLI.** `/model` is a picker with effort on the arrow keys; `/fast` toggles, and a `↯` beside the prompt shows it is on; Shift+Tab cycles the permission mode and the status line names it ([model config](https://code.claude.com/docs/en/model-config)).

Pattern: model, effort and fast grouped in one model menu, permissions a control of their own; on the phone, permissions folded behind **+**.

## Codex

- **Desktop app and web.** One "model and reasoning control beneath the composer" reads like "6 Sol Light" when closed and opens a slider of presets from Faster to Smarter, with **Advanced** for a specific model, effort or speed ([models](https://learn.chatgpt.com/docs/models), [web](https://learn.chatgpt.com/docs/web)). Permissions are a separate control below the composer, a list titled "How should ChatGPT actions be approved?" with Ask for approval, Approve for me, Full access and Custom ([permission modes](https://learn.chatgpt.com/docs/permission-modes)). Plan mode is in the composer's **Add** menu ([features](https://learn.chatgpt.com/docs/features)).
- **ChatGPT iPhone app.** The composer shows a model label such as "6 Astra"; the docs do not say what a tap opens. Approvals there are cards per request, not a mode ([mobile](https://learn.chatgpt.com/docs/mobile)). The changelog mentions Plan mode and a Custom permission mode on iOS without saying where their controls sit ([changelog](https://learn.chatgpt.com/docs/changelog)).
- Not verified: a reported compact effort gauge on iOS, and a long-press on Send for effort, found only in secondary sources.

Pattern: model, effort and speed in one control; permissions apart, because they carry the risk.

## T3 Code

- **iPhone (`apps/mobile`).** One "Model and reasoning settings" chip in the composer: the provider's icon, the short model name, then a muted summary such as "High Fast" ([ComposerModelControl.tsx](https://github.com/pingdotgg/t3code/blob/80a2351/apps/mobile/src/components/ComposerModelControl.tsx), [modelTraits.ts](https://github.com/pingdotgg/t3code/blob/80a2351/packages/client-runtime/src/modelTraits.ts)). A tap opens a native form sheet, **Thread settings**, full height with a grabber: a searchable model list grouped by provider, an Options list where effort is a row that pushes its choices and fast is a switch, and a Runtime row for Supervised, Auto-accept edits, Auto and Full access, each with a line ([ThreadSettingsSheet.tsx](https://github.com/pingdotgg/t3code/blob/80a2351/apps/mobile/src/features/threads/ThreadSettingsSheet.tsx)).
- **Web and desktop (`apps/web`).** Separate chips in the composer footer: the model picker (a popover with a provider sidebar), an effort chip whose menu also holds fast and shows a zap when it is on, a Build/Plan toggle, and a Permissions chip with an icon and label. In a narrow window the extra chips fold into a "More composer controls" menu ([ComposerFooterControls.tsx](https://github.com/pingdotgg/t3code/blob/80a2351/apps/web/src/components/chat/ComposerFooterControls.tsx), [CompactComposerControlsMenu.tsx](https://github.com/pingdotgg/t3code/blob/80a2351/apps/web/src/components/chat/CompactComposerControlsMenu.tsx)).

## What this suggests for the iPhone

1. **One chip, one sheet** (T3 Code's iPhone app). Least room in the composer; all four together.
2. **Separate chips in the composer** (Claude Code's desktop and web, T3 Code's web). Each setting one press away, at the cost of a second line in the reply box.
3. **One control for model, effort and speed, permissions apart** (Codex). The desktop's quiet pill already does this: the split chip, and the shield at the pill's start (ADR-0161).
