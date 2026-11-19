// Each provider's fixture as the referee harness makes it, with the fixture's own defaults: the referee host makes its
// adapter from it (`tests/fixtures/refereeNodeHost.ts`), and the contract across the socket uses the same fixture's driver,
// which acts on the fake through files in the data folder alone (`tests/referee/socketFixture.ts`).
import type { AdapterContractSkips, AdapterFixture } from '../fixtures/adapterFixture'
import { claudeFixture, claudeFixtureSkips } from '../fixtures/claudeFixture'
import { codexFixture, codexFixtureSkips } from '../fixtures/codexFixture'
import { devinFixture, devinFixtureSkips } from '../fixtures/devinFixture'
import { grokFixture, grokFixtureSkips } from '../fixtures/fakeGrokThreadFixture'
import { museFixture, museFixtureSkips } from '../fixtures/museFixture'
import { opencodeFixture, opencodeFixtureSkips } from '../fixtures/fakeOpenCodeFixture'
import { cursorFixture, cursorFixtureSkips } from '../fixtures/fakeCursorFixture'
import type { RefereeProvider } from './providers'

/** A fixture over `root`, or over a folder of its own when `root` is left out. Codex's adapter is its own, unwrapped. */
export const REFEREE_FIXTURES: Readonly<Record<RefereeProvider, (root?: string) => Promise<AdapterFixture>>> = {
  codex: root => codexFixture(root, false), claude: root => claudeFixture(root), grok: root => grokFixture(root),
  devin: root => devinFixture(root), muse: root => museFixture(root), opencode: root => opencodeFixture(root),
  cursor: root => cursorFixture(root),
}

/** What each fixture's adapter does not do in process, which it does not do across the socket either. */
export const REFEREE_FIXTURE_SKIPS: Readonly<Record<RefereeProvider, AdapterContractSkips>> = {
  codex: codexFixtureSkips, claude: claudeFixtureSkips, grok: grokFixtureSkips, devin: devinFixtureSkips, muse: museFixtureSkips,
  opencode: opencodeFixtureSkips, cursor: cursorFixtureSkips,
}
