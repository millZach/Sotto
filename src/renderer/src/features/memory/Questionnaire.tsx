import React, { useEffect, useRef, type ReactNode } from 'react'
import { MAX_MEMORY_CONTENT_CHARACTERS, type MemoryCommand, type MemoryTopic } from '../../../../shared/memory'
import { Button } from '../../components/Button'
import { questions, boundaryLabels } from './questions'

type Boundary = keyof typeof boundaryLabels
export interface QuestionnaireDraft { step: number; answers: Partial<Record<MemoryTopic, string>>; boundaries: Boundary[] }
export const emptyQuestionnaire: QuestionnaireDraft = { step: 0, answers: {}, boundaries: [] }

export function Questionnaire({ draft, onChange, onSave, onLater, busy, error }: {
  draft: QuestionnaireDraft
  onChange: (draft: QuestionnaireDraft) => void
  onSave: (command: Extract<MemoryCommand, { type: 'complete-questionnaire' }>) => Promise<boolean>
  onLater: () => void
  busy: boolean
  error: string
}): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [draft.step])
  const question = questions[draft.step]
  const review = draft.step === questions.length + 1
  const title = question?.question ?? (review ? 'Here’s what Sotto will remember' : 'What should Sotto always confirm?')
  const answer = question ? draft.answers[question.topic] ?? '' : ''
  const changeAnswer = (content: string) => { if (question) onChange({ ...draft, answers: { ...draft.answers, [question.topic]: content } }) }
  return <section className="memory-page memory-conversation" aria-label="Working preferences">
    <div className="memory-step" key={draft.step}>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      {question ? <>
        <p className="memory-description" id="memory-question-hint">{question.hint}</p>
        <textarea className="memory-answer" aria-label={question.question} aria-describedby="memory-question-hint" maxLength={MAX_MEMORY_CONTENT_CHARACTERS} rows={5}
          value={answer} onChange={event => changeAnswer(event.target.value)} disabled={busy} />
        <Button variant="ghost" onClick={() => changeAnswer('No preference.')} disabled={busy}>No preference</Button>
      </> : review ? <>
        <p className="memory-description">Saved on this computer. Relevant preferences go to your selected reasoning provider when Sotto interprets a request.</p>
        <div className="memory-review">{questions.map((item, index) => <div key={item.topic}>
          <div><p>{draft.answers[item.topic]}</p><p className="memory-meta">{item.question}</p></div>
          <Button variant="ghost" onClick={() => onChange({ ...draft, step: index })} disabled={busy} aria-label={`Change ${item.topic} answer`}>Change</Button>
        </div>)}</div>
        <p>{draft.boundaries.length ? `Always confirm: ${draft.boundaries.map(boundary => boundaryLabels[boundary].toLowerCase()).join('; ')}.` : 'Your existing permission boundaries stay in place.'}</p>
        <p className="memory-description">Answers are preferences. Only the confirmation choices create policies; they grant no new permissions.</p>
      </> : <>
        <p className="memory-description">These choices become explicit policies. Leaving a box unchecked grants no permission.</p>
        <div className="memory-boundaries">{(Object.keys(boundaryLabels) as Boundary[]).map(boundary => <label key={boundary}>
          <input type="checkbox" checked={draft.boundaries.includes(boundary)} disabled={busy} onChange={event => onChange({ ...draft,
            boundaries: event.target.checked ? [...draft.boundaries, boundary] : draft.boundaries.filter(value => value !== boundary),
          })} />{boundaryLabels[boundary]}
        </label>)}</div>
      </>}
    </div>
    {error && <p role="alert" className="memory-error">{error}</p>}
    <div className="memory-actions">
      {draft.step > 0 && <Button variant="secondary" disabled={busy} onClick={() => onChange({ ...draft, step: draft.step - 1 })}>Back</Button>}
      {review ? <Button disabled={busy} onClick={() => void onSave({ type: 'complete-questionnaire', answers: questions.map(item => ({ topic: item.topic, content: draft.answers[item.topic] ?? '' })), boundaries: draft.boundaries })}>{busy ? 'Saving…' : 'Save preferences'}</Button>
        : <Button disabled={busy || (question !== undefined && !answer.trim())} onClick={() => onChange({ ...draft, step: draft.step + 1 })}>Continue</Button>}
      <Button variant="ghost" disabled={busy} onClick={onLater}>Not now</Button>
      <span className="memory-progress" aria-label={`Step ${draft.step + 1} of 9`}>{draft.step + 1} / 9</span>
    </div>
  </section>
}
