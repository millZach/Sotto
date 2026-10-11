import React, { type ReactNode } from 'react'

import type { ThemeBrand } from '../../../shared/themeBranding'
import { useThemeBrand } from './useThemeBrand'

export interface SottoMarkProps {
  /** Sizing hook; the mark has no intrinsic size of its own. */
  readonly className?: string | undefined
  /** Paints the mark in another theme's colours, as a theme's preview does, instead of the window's. */
  readonly brand?: Pick<ThemeBrand, 'tile' | 'glyph'> | undefined
}

/** The owl's head with its eyes and beak cut out, in build/icon.svg's 96-unit tile. */
const OWL_PATH =
  'M18.24 33.84C16.32 30 15.84 22.8 19.2 18C19.8 16.8 21.12 15.6 21.72 18C21.96 21.6 24.6 25.44 30 25.44C38.4 22.32 57.6 20.4 69.84 27.36C73.2 27.12 76.32 24.6 76.56 20.64C76.8 19.56 77.76 19.56 78.24 21.36C80.4 24 81.36 31.44 78.72 37.2C80.64 39.6 82.08 45.6 82.08 55.2C82.32 66.24 80.28 71.76 74.4 75.6C69 79.8 57.6 80.04 48 80.04C38.28 80.04 26.88 79.8 21.48 75.6C15.6 71.76 13.56 66.24 13.8 55.2C13.68 44.4 14.88 38.4 18.24 33.84Z'
  + 'M20.76 52.2C20.64 43.8 22.56 39.48 28.8 39.48C36.24 39.24 42.48 40.08 42.36 50.4C42.36 58.8 39.6 62.64 31.8 62.64C24 62.76 20.64 59.4 20.76 52.2Z'
  + 'M53.88 53.4C53.88 48.6 55.2 46.56 58.8 45.6L70.56 43.2C73.68 42.6 75.12 45.6 75.12 51.6C75.24 60 73.2 62.76 64.2 62.76C57.6 62.76 53.88 60 53.88 53.4Z'
  + 'M45.6 59.88C47.04 59.52 48.96 59.52 50.4 59.88C51.6 60.12 51.72 61.08 51.12 61.8L48.6 65.64C48.24 66.24 47.76 66.24 47.4 65.64L44.88 61.8C44.28 61.08 44.4 60.12 45.6 59.88Z'

/**
 * The Sotto mark, the owl. Its geometry is kept in step with build/icon.svg;
 * its colours follow the window's theme: the tile is the accent and the owl
 * takes a foreground that reads on it. The eyes and beak are holes in the owl,
 * so they always show the tile behind them.
 */
export function SottoMark({ className, brand: shown }: SottoMarkProps): ReactNode {
  const windowBrand = useThemeBrand()
  const brand = shown ?? windowBrand

  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 96 96" data-tile={brand.tile} data-glyph={brand.glyph}>
      <rect width="96" height="96" rx="22" fill={brand.tile} />
      <path d={OWL_PATH} fill={brand.glyph} fillRule="evenodd" />
      <circle cx="36" cy="48.96" r="3.12" fill={brand.glyph} />
      <circle cx="60.36" cy="51.84" r="3.12" fill={brand.glyph} />
    </svg>
  )
}
