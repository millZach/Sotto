import { contrastRatio } from '../../../../shared/themes/color'
import { LIGHT_ACCENT_BOOST, LIGHT_INK_BOOST, over, sceneInk, WORD_CONTRAST, type Rgb, type SceneInk } from '../../watcher/nightScene'

export interface ChamberInk extends SceneInk {
  /** The faintest step that keeps a figure distinct, and words readable, against the room. Art keeps the whole ramp. */
  readonly figure: { readonly ink: number; readonly accent: number }
  readonly words: { readonly ink: number; readonly accent: number }
}

/** Watcher's theme ramps, with contrast floors for the chamber's figures and words, worked out only when ink changes. */
export function chamberInk(surface: Rgb, text: Rgb, accent: Rgb): ChamberInk {
  const ink = sceneInk(surface, text, accent)
  const floor = (color: Rgb, boost: number, minimum: number): number => {
    for (let step = 1; step <= 20; step++) {
      // The same two-decimal alpha as sceneInk paints, including its stronger ink on light surfaces.
      const alpha = Number(Math.min(1, step / 20 * boost).toFixed(2))
      if (contrastRatio(surface, over(surface, color, alpha)) >= minimum) return step / 20
    }
    return 1
  }
  const inkBoost = ink.light ? LIGHT_INK_BOOST : 1, accentBoost = ink.light ? LIGHT_ACCENT_BOOST : 1
  return { ...ink,
    figure: { ink: floor(text, inkBoost, 3), accent: floor(accent, accentBoost, 3) },
    words: { ink: floor(text, inkBoost, WORD_CONTRAST), accent: floor(accent, accentBoost, WORD_CONTRAST) },
  }
}
