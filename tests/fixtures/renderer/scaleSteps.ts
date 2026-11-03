/** The `--tt-type-*` and `--tt-radius-*` steps a token sheet declares (ADR-0169), by name, as written. Comments are skipped. */
export function scaleSteps(css: string): ReadonlyMap<string, string> {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/(--tt-(?:type|radius)-[a-z]+)\s*:\s*([^;]+);/gu)
  return new Map([...declarations].map(([, name, value]) => [name!, value!.trim()] as const))
}
