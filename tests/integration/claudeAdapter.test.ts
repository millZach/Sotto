// @vitest-environment node
import { describeAdapterContract } from './adapterContract'
import { claudeFixture } from '../fixtures/claudeFixture'
describeAdapterContract('Claude stream-json', () => claudeFixture(undefined, 1000))
