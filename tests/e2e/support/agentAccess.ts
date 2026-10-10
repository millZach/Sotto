import type { Page } from '@playwright/test'
import type { AgentCommand, AgentCommandReceipt, AgentState, AgentThreadDetail } from '../../../src/shared/agents'

export async function agentCommand(page: Page, command: AgentCommand): Promise<AgentCommandReceipt> {
  return page.evaluate(async request => {
    const bridge = window.sotto?.agents
    if (!bridge) throw new Error('Agent bridge unavailable')
    return bridge.command(request)
  }, command)
}

/** A shell read does not fetch a conversation. Tests needing messages must read detail explicitly. */
export async function agentState(page: Page): Promise<AgentState> {
  return page.evaluate(async () => {
    const bridge = window.sotto?.agents
    if (!bridge) throw new Error('Agent bridge unavailable')
    return bridge.get()
  })
}

export async function agentThreadDetail(page: Page, threadId: string): Promise<AgentThreadDetail | null> {
  return page.evaluate(async id => {
    const bridge = window.sotto?.agents
    if (!bridge?.threadDetail) throw new Error('Thread detail bridge unavailable')
    return bridge.threadDetail(id)
  }, threadId)
}
