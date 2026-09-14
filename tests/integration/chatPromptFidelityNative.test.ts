// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexSubscriptionClient } from '../../src/main/agents/subscriptionCodex'
import { CHAT_PROMPT_INSTRUCTIONS, renderChatPrompt } from '../../src/main/agents/chatPrompts'
import { chatPromptCases } from '../fixtures/chatPromptCases'

it.runIf(process.env.SOTTO_NATIVE_PROMPT_REVIEW === '1')('records real text-only prompt outputs for fidelity and human usefulness review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-prompt-review-'))
  const client = new CodexSubscriptionClient(root)
  const results: { name: string; input: unknown; outline: unknown; text: string; review: string }[] = []
  await mkdir('artifacts/phase-four-prompts', { recursive: true })
  try {
    for (const fixture of chatPromptCases) {
      const input = { messages: fixture.messages }
      const outline = await client.complete(CHAT_PROMPT_INSTRUCTIONS, input, 'gpt-6-astra', 'low')
      const text = renderChatPrompt(outline, input)
      expect(text.length).toBeGreaterThan(0)
      results.push({ name: fixture.name, input, outline, text, review: fixture.review })
      await writeFile('artifacts/phase-four-prompts/native-results.json', JSON.stringify({ model: 'gpt-6-astra', effort: 'low', checkedAt: new Date().toISOString(), results }, null, 2))
    }
  } finally {
    await writeFile('artifacts/phase-four-prompts/review.md', `# Prompt format review\n\nThese are actual text-only native outputs from four synthetic conversations. Source-quote validation passed. Semantic fidelity and usefulness require reading each output; automated validation does not establish them. Human review is pending, so the format is provisional.\n\nRubric (0–2 each): objective fidelity; latest corrections; decisions versus suggestions; constraints/non-goals; deliverables/acceptance; unresolved details; useful standalone wording. A hard failure is any invented requirement, unaccepted suggestion promoted to a decision, discarded correction, silently resolved contradiction or omitted essential constraint.\n\n${results.map(result => `## ${result.name}\n\nReview checks: ${result.review}\n\n### Conversation\n\n${(result.input as { messages: { role: string; text: string }[] }).messages.map(message => `**${message.role}:** ${message.text}`).join('\n\n')}\n\n### Generated prompt\n\n${result.text}`).join('\n\n---\n\n')}`)
  }
}, 300000)
