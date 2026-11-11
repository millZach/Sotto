// The parts of jpeg-js (BSD-3-Clause, its decoder Apache-2.0) and pngjs (MIT) the headless host's picture worker calls
// (`pictureCopy.ts`, ADR-0203). The worker reaches jpeg-js's decoder alone, which jpeg-js's own declarations do not
// cover, and pngjs's synchronous half alone, which pngjs ships no declarations for, so neither jpeg-js's encoder nor
// pngjs's stream-based reader and writer is in the host's bundle. Typed from each package's own source.
declare module 'jpeg-js/lib/decoder' {
  /** A decoded JPEG as four bytes a pixel, red, green, blue and alpha, the alpha always opaque. */
  export interface DecodedJpeg { readonly width: number; readonly height: number; readonly data: Uint8Array }
  export default function decode(jpegData: Uint8Array, options: {
    readonly useTArray: true
    readonly formatAsRGBA?: boolean
    readonly tolerantDecoding?: boolean
    readonly maxResolutionInMP?: number
    readonly maxMemoryUsageInMB?: number
  }): DecodedJpeg
}

declare module 'pngjs/lib/png-sync' {
  /** A decoded PNG: its pixels as four bytes a pixel, red, green, blue and alpha, whatever its own colour type was. */
  export interface DecodedPng {
    readonly width: number
    readonly height: number
    readonly data: Buffer
    /** Whether it has an alpha channel or a transparent colour of its own. */
    readonly alpha: boolean
  }
  export interface PngWriteOptions {
    readonly colorType?: 0 | 2 | 4 | 6
    readonly inputColorType?: 0 | 2 | 4 | 6
    readonly inputHasAlpha?: boolean
    readonly bitDepth?: 8 | 16
    readonly deflateLevel?: number
  }
  export function read(buffer: Buffer, options?: { readonly checkCRC?: boolean; readonly skipRescale?: boolean }): DecodedPng
  export function write(png: { readonly width: number; readonly height: number; readonly data: Uint8Array }, options?: PngWriteOptions): Buffer
}
