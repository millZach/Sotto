/**
 * The type steps tokens.css names as `--tt-type-*` (ADR-0169), in pixels, for text drawn where the window's stylesheets
 * do not reach: a Mermaid diagram is laid out in a document of its own. scaleTokens.test.ts holds the two equal.
 */
export const TYPE_STEPS = { micro: 11, caption: 12, small: 13, body: 14, reading: 15, lead: 16, heading: 18, figure: 22, title: 28 } as const
