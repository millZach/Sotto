import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Keep run evidence disposable unless publication is explicitly requested. */
export function evidenceDirectory(defaultDirectory: string): string {
  const name = relative(resolve('artifacts'), resolve(defaultDirectory))
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    throw new Error(`Evidence directory must be inside artifacts/: ${defaultDirectory}`)
  }
  const root = process.env.SOTTO_E2E_ARTIFACT_ROOT
  if (root) return resolve(root, name)
  if (process.env.SOTTO_E2E_EVIDENCE === 'publish') return resolve(defaultDirectory)
  return resolve('artifacts/e2e-runs', name)
}
