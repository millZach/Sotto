/** The upper middle sample, including for an even sample count. Keep historical benchmark figures. */
export function upperMedian(samples) {
  const sorted = [...samples].sort((first, second) => first - second)
  return sorted[Math.floor(sorted.length / 2)]
}

/** The existing benchmarks select a sample by floor(length * fraction), capped at the last sample. */
export function percentile(samples, fraction) {
  const sorted = [...samples].sort((first, second) => first - second)
  return sorted[Math.min(samples.length - 1, Math.floor(samples.length * fraction))]
}
