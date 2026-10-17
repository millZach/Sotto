import type { AgentCommand, AgentHostSnapshot, AgentModel } from '../../shared/agents'
import type { HeldProviders } from '../../shared/heldProviders'
import { heldProviderOfClientUpdateEnumeration, heldProviderOfCommand, modelsWithoutHeld } from './heldProviderGate'

/** Muse's names for the held-provider gate (`heldProviderGate.ts`), kept for the suites written against them. */
const MUSE_HELD: HeldProviders = new Set(['muse'])

export function modelsWithoutMuse(models: AgentModel[]): AgentModel[] { return modelsWithoutHeld(models, MUSE_HELD) }
export function commandUsesMuse(command: AgentCommand, snapshot?: AgentHostSnapshot): boolean {
  return heldProviderOfCommand(command, MUSE_HELD, snapshot) !== undefined
}
export function clientUpdateEnumerationUsesMuse(command: AgentCommand, snapshot?: AgentHostSnapshot): boolean {
  return heldProviderOfClientUpdateEnumeration(command, MUSE_HELD, snapshot) !== undefined
}
