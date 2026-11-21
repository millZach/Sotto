import { z } from 'zod'
import { agentConfigurationSchema, enabledThreadProviders, parsePublicProviderEntityId, type AgentConfiguration } from '../../shared/agents'
import { providerIdSchema, type ProviderId } from '../../shared/providerIds'

/**
 * A held provider's choices, parked while stable uses an available provider; ordinary choices remain editable. Only
 * what was parked is read back: the configuration's defaults would otherwise fill in a provider and an effort it never had.
 * Taken out of `control.ts` (ADR-0190).
 */
export const dormantProviderConfigurationSchema = agentConfigurationSchema.pick({ defaultModelId: true, newThreadModelId: true }).partial().extend({
  provider: providerIdSchema.optional(), newThreadReasoningEffort: agentConfigurationSchema.shape.newThreadReasoningEffort.unwrap().optional(),
  enabled: z.boolean().optional(), newThreadRuntimeMode: agentConfigurationSchema.shape.newThreadRuntimeMode.nullable() })
export type DormantProviderConfiguration = z.infer<typeof dormantProviderConfigurationSchema>

/** A held provider's choices in the saved configuration, over what it already had parked. */
export function parkedChoices(configuration: AgentConfiguration, provider: ProviderId, held: DormantProviderConfiguration | undefined): DormantProviderConfiguration {
  const dormant = { ...held }
  if (configuration.provider === provider) dormant.provider = provider
  if (enabledThreadProviders(configuration).includes(provider)) dormant.enabled = true
  if (parsePublicProviderEntityId(configuration.defaultModelId)?.provider === provider) dormant.defaultModelId = configuration.defaultModelId
  if (parsePublicProviderEntityId(configuration.newThreadModelId)?.provider === provider) {
    dormant.newThreadModelId = configuration.newThreadModelId; dormant.newThreadReasoningEffort = configuration.newThreadReasoningEffort
    dormant.newThreadRuntimeMode = configuration.newThreadRuntimeMode ?? null
  }
  return dormant
}
