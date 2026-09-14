# Index Settings implementation

Deliverable: replace the production settings stack with the user-selected Index design. The proving moment is changing a setting in one focused category without scrolling past unrelated controls.

## Acceptance
- Reference: `prototype/settings-redesigns`, variant A; screenshots and README remain preserved in that worktree. Earlier alternatives Find and Flow were reviewed; Zach selected Index.
- Windows desktop at 1600×1000, 1280×800 and 820×560. Keep Sotto shell, typography, themed icon/orb/widget, stable category sidebar (~238px at standard widths), centered focused form, thin row dividers and generous spacing.
- All eight real categories and existing actions remain available. Preserve draft races, save failures, provider/account/voice behavior, theme editing/import/export, updates and destructive confirmation dialogs. No demo controls or data on normal app routes.
- Exactly one category visible and keyboard reachable at a time; preserve drafts and asynchronous actions across navigation. Feedback remains visible without covering fields. Navigation/form scroll independently in short windows.
- Real control labels ≥14px, supporting copy ≥12px; remove repeated state summaries. Opening copy budget: Settings, category title and concise category scope (3); essential navigation, field labels, units, operating instructions and state feedback are functional content.
- Selection and form arrival use restrained motion; reduced motion removes movement. Theme roles drive all new styling.
- Verify real Windows Electron user journeys using a disposable profile, inspect category screenshots at target sizes and light/dark, test persistence and important failure states. Compare actual render to Index before delivery.

## State
- Created `feat/settings-index` from local Sidecar implementation `0cfedf7`; prototype branch remains unchanged.
- Production implementation complete. Eight focused mounted categories preserve child drafts; category changes reset the form scroll without remounting it. Keyboard Up/Down/Home/End select categories; Tab enters the active panel.
- Appearance uses compact per-mode swatches and a passive live icon/orb/widget preview. All existing theme editor, inspector, import/export, duplicate and remove actions remain available. Widget preview resolves the OS mode independently, like the real widget.
- Providers now exposes its connection action in the 820×560 first screen. Agents starts with real account controls, then voice, with wake paths in an advanced disclosure. Voice fields include their own Settings styles so direct entry works before the lazy Agents stylesheet loads.
- Validation and rendered review complete; see `docs/verification/settings-index.md`. No remaining material implementation gaps. Delivered locally on `feat/settings-index`; remote push/merge not part of this request.
