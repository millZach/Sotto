# Formatting quality menu contrast

September 11, 2026. The reported Windows popup had near-white option text on a
white native background. Live computed styles showed dark color-scheme and
`rgb(243, 244, 243)` text, but transparent option backgrounds.

Added paired foreground/background colors for native `select option` and
`optgroup` elements in management-window `global.css`, plus muted disabled-option
text. This covers Formatting quality and neighboring native dropdowns without
replacing their keyboard/selection behavior or changing any quality setting.

Verification: the live dev style probe changed from transparent option backgrounds
to `rgb(18, 21, 20)`; production build passed. An isolated Electron profile
exercised changing quality, opening the native popup, and dismissing it. Inspected
the actual Windows popup captured in
`artifacts/formatting-quality-native-menu.png`: every option is readable on its
dark surface, with the selected option highlighted. No new automated test suite
was added for this scoped CSS change; diagnostic scripts were removed afterward.

The existing dev renderer received the CSS through hot reload. The user's saved
quality remained Medium during verification.
