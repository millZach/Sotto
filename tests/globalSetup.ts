import { assertTemporaryFolderOutsideRepositories } from './fixtures/gitGuard'

/**
 * Runs once, before any test file. Tests make plain folders under the temporary folder and expect Git to find no
 * repository there; a TEMP inside a checkout let Git find that checkout instead, and a test committed in it. The run
 * stops here, with what to change, rather than letting the first such test reach the checkout.
 */
export default function setup(): void {
  assertTemporaryFolderOutsideRepositories()
}
