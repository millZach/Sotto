import { z } from 'zod'
import { agentConfigurationSchema, agentStateSchema } from '../../src/shared/agents'

// Copied from main's pre-removal schema (268fa07d): these were required, and configuration was strict.
// All other fields share today's unchanged domain shapes.
export const olderDesktopAccountSchema = agentStateSchema.extend({
  configuration: agentConfigurationSchema.extend({
    membershipEndpoint: z.string().max(2_048),
    followupLimit: z.number().int().min(0).max(100),
    orbColor: z.enum(['teal', 'violet', 'ice', 'amber', 'mono']),
    speak: z.boolean(), speechProvider: z.enum(['grok', 'kokoro', 'natural', 'system']),
    speechVoice: z.enum(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5']),
    grokSpeechVoice: z.string().min(1).max(256),
    wakeModelDirectory: z.string().max(4_096), wakeRuntimeDirectory: z.string().max(4_096),
  }).strict(),
  speech: z.object({ id: z.number(), text: z.string(), preview: z.boolean().optional() }),
  voice: z.object({ status: z.string(), error: z.string().nullable(),
    action: z.enum(['none', 'mute', 'unmute', 'stop-speaking', 'sleep']), revision: z.number() }),
  credentials: z.object({ reasoning: z.boolean(), grokSpeech: z.boolean().default(false), secure: z.boolean() }),
  membership: z.object({
    status: z.enum(['beta', 'free', 'active', 'expired', 'unavailable']),
    label: z.string(), expiresAt: z.string().nullable(),
  }),
})
