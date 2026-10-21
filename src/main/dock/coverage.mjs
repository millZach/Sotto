// The Dock icon's coverage file: scripts/generate-brand-assets.mjs writes it, dockIcon.ts paints it, and
// scripts/verify-packaged-resources.mjs checks a Mac build carries it. Plain JavaScript so the scripts read it too.

/** The coverage's side in pixels. */
export const DOCK_COVERAGE_SIZE = 512

/** Its length once inflated: per pixel, the tile's coverage then the glyph's, one byte each. */
export const DOCK_COVERAGE_BYTES = DOCK_COVERAGE_SIZE * DOCK_COVERAGE_SIZE * 2
