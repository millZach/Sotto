import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Best-effort startup cleanup of the legacy install ID file left by earlier versions
 * before ADR-0179 was reversed. Non-fatal on any error.
 */
export async function removeLegacyTelemetryFiles(directory: string): Promise<void> {
  await rm(join(directory, 'product-events-install-id'), { force: true }).catch(() => undefined)
}
