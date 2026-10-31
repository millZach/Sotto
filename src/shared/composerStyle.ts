/**
 * The thread composer's two styles (ADR-0168): Zach's composer, the prompt on its own row above a quiet footer, and
 * Drake's composer, one pill (ADR-0161). Settings → Appearance chooses; Zach's is the default.
 */
export type ComposerStyle = 'rows' | 'pill'
export const COMPOSER_STYLES = ['rows', 'pill'] as const satisfies readonly ComposerStyle[]
export const DEFAULT_COMPOSER_STYLE: ComposerStyle = 'rows'
