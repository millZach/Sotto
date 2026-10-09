import { basename, resolve } from 'node:path'

/** Keep run evidence disposable unless publication is explicitly requested. */
export function evidenceDirectory(defaultDirectory: string): string {
  const root = process.env.SOTTO_E2E_ARTIFACT_ROOT
  if (root) return resolve(root, basename(defaultDirectory))
  if (process.env.SOTTO_E2E_EVIDENCE === 'publish') return resolve(defaultDirectory)
  return resolve('test-results/e2e-evidence', basename(defaultDirectory))
}
