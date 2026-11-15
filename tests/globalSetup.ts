import { assertTemporaryFolderOutsideRepositories } from './fixtures/gitGuard'
import { OFF_PINNED_NODE_MESSAGE, ON_PINNED_NODE } from './fixtures/pinnedNode'

/**
 * Runs once, before any test file. Tests make plain folders under the temporary folder and expect Git to find no
 * repository there; a TEMP inside a checkout let Git find that checkout instead, and a test committed in it. The run
 * stops here, with what to change, rather than letting the first such test reach the checkout.
 *
 * It also says, once, when the run is on another Node major than CI's (#2339): the run goes on, since most tests do not
 * depend on it, and the one budget that does skips itself.
 */
export default function setup(): void {
  assertTemporaryFolderOutsideRepositories()
  if (!ON_PINNED_NODE) console.warn(`\n${OFF_PINNED_NODE_MESSAGE}\n`)
}
