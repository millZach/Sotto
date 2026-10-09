// @vitest-environment node
import { expect, it } from 'vitest'
import { devinReadInterval, isDevinTurnWork } from '../../../src/main/agents/devin'

it('counts only the work a running prompt streams as Devin taking it', () => {
  for (const kind of ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan']) expect(isDevinTurnWork(kind)).toBe(true)
  // Background work an earlier turn started may still report a tool call update after its turn ended.
  for (const kind of ['tool_call_update', 'user_message_chunk', 'current_mode_update', 'config_option_update', 'available_commands_update', undefined, 1]) {
    expect(isDevinTurnWork(kind)).toBe(false)
  }
})

it('reads a held thread at the busy pace only while its prompt has not been shown taken', () => {
  expect(devinReadInterval(true)).toBe(1_500)
  // Taken on the stream, or no turn at all: the thread's own stream carries it, so it is read at the idle pace.
  expect(devinReadInterval(false)).toBe(15_000)
  expect(devinReadInterval(true, 20)).toBe(20)
  expect(devinReadInterval(false, 20)).toBe(20)
})
