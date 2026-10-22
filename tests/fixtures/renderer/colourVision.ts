/**
 * How far apart two colours look, with full colour vision and with the two common red-green differences. The
 * simulation is Machado, Oliveira and Fernandes (2009) at full severity, applied in linear sRGB; distance is
 * Euclidean in OKLab times 100, the scale the chart palette was chosen on (8 apart reads as distinct).
 */
export type Vision = 'normal' | 'protan' | 'deutan'
interface Rgb { readonly r: number; readonly g: number; readonly b: number }

const MACHADO: Record<Exclude<Vision, 'normal'>, readonly (readonly number[])[]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
}
const linear = (channel: number): number => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 }

function oklab([r, g, b]: readonly number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!)
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!)
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function seen(color: Rgb, vision: Vision): [number, number, number] {
  const rgb = [linear(color.r), linear(color.g), linear(color.b)]
  if (vision === 'normal') return oklab(rgb)
  return oklab(MACHADO[vision].map(row => Math.min(1, Math.max(0, row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!))))
}

/** OKLab distance times 100 between two colours as a reader with this vision sees them. */
export function visionDistance(first: Rgb, second: Rgb, vision: Vision): number {
  const [a, b] = [seen(first, vision), seen(second, vision)]
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100
}
