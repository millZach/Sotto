# Composer selectors

Selected by Zach: prototype A, Chips. The composer's one option pill ("Fable · High · Auto") becomes three selectors, each a bordered chip in the composer footer: the model with its provider mark, the reasoning effort, and the permissions. The model chip opens a compact menu anchored over it, with provider tabs across the top, a search line and the list; the effort and permission chips open a short list each.

- Reference: `prototype/composer-selectors` (also on this thread's branch), `docs/prototypes/composer-selectors-prototype.html`, `?variant=a`; screenshots in `artifacts/composer-selectors-prototypes/`. Variants B (Labelled) and C (Shelf) were reviewed and not chosen.
- Zach noted the prototype's Codex and Grok model names were out of date and that Claude's efforts lacked `xhigh` and `ultracode`. Those lists were the prototype's own stand-ins. In the app every model list comes from the provider itself, and Claude's efforts are the `supportedEffortLevels` Claude Code reports at initialize (`subscriptionClaude.ts`); the installed Claude Code reports low, medium, high, xhigh and max. `ultracode` is a prompt keyword in Claude Code, not an effort level it offers, so the selector cannot list it.
- The effort control is drawn plainly for now. Zach has another idea for it, to follow once the chips and the model menu are in.
- Next after this: the New thread dialog.
