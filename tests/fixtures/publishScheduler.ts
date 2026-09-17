import type { PublishScheduler } from '../../src/main/agents/control'

/**
 * Closes the broadcast window the moment it opens, so every publish reaches listeners
 * synchronously. Tests that call a command and then read a listener's last value take this;
 * the coalescing itself is covered with a fake clock in tests/unit/main/agentStatePublishing.test.ts.
 */
export const immediatePublishScheduler: PublishScheduler = run => {
  run()
  return () => undefined
}
