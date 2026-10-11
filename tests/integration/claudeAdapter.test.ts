// @vitest-environment node
import { describeAdapterContract } from './adapterContract'
import { claudeFixture, claudeFixtureSkips } from '../fixtures/claudeFixture'
describeAdapterContract('Claude stream-json', session => claudeFixture(undefined, undefined, undefined, session), claudeFixtureSkips)
