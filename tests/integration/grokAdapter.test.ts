// @vitest-environment node
import { describeAdapterContract } from './adapterContract'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
describeAdapterContract('Grok ACP', session => grokFixture(undefined, undefined, undefined, session))
