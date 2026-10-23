// Temporary diagnostic for the terminal zoom race; removed before merge.
type Diag = { __zoomDiag?: [string, number][] }
export const zoomDiag = (label: string): void => { (globalThis as Diag).__zoomDiag?.push([label, Date.now()]) }
export async function zoomTimed<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  zoomDiag(`${label}:start`)
  try { return await run() } finally { zoomDiag(`${label}:end`) }
}
