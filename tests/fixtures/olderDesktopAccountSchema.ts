import { z } from 'zod'
import { agentConfigurationSchema, agentStateSchema } from '../../src/shared/agents'

// Copied from main's pre-removal schema (268fa07d): these were required, and configuration was strict.
// All other fields share today's unchanged domain shapes.
export const olderDesktopAccountSchema = agentStateSchema.extend({
  configuration: agentConfigurationSchema.extend({ membershipEndpoint: z.string().max(2_048) }).strict(),
  membership: z.object({
    status: z.enum(['beta', 'free', 'active', 'expired', 'unavailable']),
    label: z.string(), expiresAt: z.string().nullable(),
  }),
})
