import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentModel } from '../../../../src/shared/agents'
import { effortLabel } from '../../../../src/renderer/src/agents/effortNames'
import { effortChoices, threadOptionsSummary } from '../../../../src/renderer/src/agents/permissionPresentation'
import { ProviderModelList } from '../../../../src/renderer/src/agents/ProviderModelList'

afterEach(cleanup)

const codex = { id: 'gpt-6', name: 'GPT-6', reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' } as AgentModel

describe('one name for each reasoning effort level (#227)', () => {
  it('names a level the same whatever its spelling, and a level it does not know as the provider does, capitalised', () => {
    for (const id of ['xhigh', 'x-high', 'Extra_High', 'extra high']) expect(effortLabel(id)).toBe('XHigh')
    expect(['none', 'minimal', 'low', 'medium', 'high', 'max', 'ultracode'].map(effortLabel)).toEqual(['None', 'Minimal', 'Low', 'Medium', 'High', 'Max', 'Ultracode'])
    expect(effortLabel('ultra')).toBe('Ultra')
  })

  it('uses that name in the effort choices and a new thread\'s summary, and sends the provider its own id', () => {
    expect(effortChoices(codex, 'xhigh').map(choice => [choice.id, choice.label])).toEqual([['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'XHigh']])
    expect(effortChoices(codex, 'extra-high')[0]).toEqual({ id: 'extra-high', label: 'XHigh', disabled: true })
    expect(threadOptionsSummary(codex, 'xhigh', 'approval-required')).toBe('GPT-6 · XHigh · Ask for approval')
  })

  it('names the levels in Settings → Providers\' model list', () => {
    render(<ProviderModelList label="Codex" models={[codex]} agentEntryId={undefined} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Minimal · Low · Medium · High · XHigh')).toBeInTheDocument()
  })
})
