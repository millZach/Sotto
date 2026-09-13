/** Sanitized native 0.154 item shapes. No user transcript or hidden reasoning. */
export const activityItems = {
  command: { id: 'command-1', type: 'commandExecution', command: 'npm test', cwd: 'C:\\fixture', status: 'inProgress', commandActions: [] },
  commandDone: { id: 'command-1', type: 'commandExecution', command: 'npm test', cwd: 'C:\\fixture', status: 'completed', commandActions: [], aggregatedOutput: '2 tests passed\n', exitCode: 0, durationMs: 800 },
  change: { id: 'change-1', type: 'fileChange', status: 'completed', changes: [{ path: 'src/example.ts', kind: { type: 'update', move_path: null }, diff: '-old\n+new' }] },
  reasoning: { id: 'reasoning-1', type: 'reasoning', summary: ['Checking the public interface.'], content: ['SYNTHETIC_PRIVATE_REASONING_MUST_NOT_BE_RETAINED'] },
  tool: { id: 'tool-1', type: 'mcpToolCall', tool: 'inspect', server: 'fixture', arguments: {}, status: 'failed', error: { message: 'Fixture resource unavailable' }, result: null, durationMs: 50 },
  spawn: { id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'native-parent', receiverThreadIds: ['native-child'], prompt: 'Review the fixture', model: null, reasoningEffort: null, agentsStates: { 'native-child': { status: 'running', message: null } } },
  wait: { id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', senderThreadId: 'native-parent', receiverThreadIds: ['native-child'], prompt: null, model: null, reasoningEffort: null, agentsStates: { 'native-child': { status: 'completed', message: 'Review finished' } } },
}
