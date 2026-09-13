import { useSyncExternalStore } from 'react'
import type { AgentSkillReference } from '../../../../shared/agentSkills'
import type { PersonalChat, PersonalChatBridge } from '../../../../shared/personalChats'

type Submission = PersonalChat['submissions'][number]

/** Typing settles for this long before the draft is written; sending writes it at once. */
export const PERSONAL_DRAFT_SAVE_MS = 400

export interface PersonalDraftView {
  /** The revision this text is, or will be once saved. Revisions only grow. */
  readonly revision: number
  readonly text: string
  readonly skills: readonly AgentSkillReference[]
  readonly save: 'saved' | 'saving' | 'unsaved'
  readonly error: string | null
}

interface Entry {
  revision: number
  text: string
  skills: readonly AgentSkillReference[]
  save: PersonalDraftView['save']
  error: string | null
  timer: ReturnType<typeof setTimeout> | null
}

/** The main process's message without Electron's IPC wrapper. */
export function personalError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') || fallback
}

/**
 * Each personal chat's composer draft. Every edit is a new revision; the saved revision is written
 * before a send names it, and a revision already sent is never offered again as the composer's text.
 */
export class PersonalDraftStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): number => this.version

  /** Local edits newer than the saved draft win. A saved draft that was already sent starts the composer empty. */
  draft(chat: PersonalChat): PersonalDraftView {
    const local = this.entries.get(chat.id)
    if (local && local.revision >= chat.draft.revision) return local
    const sent = chat.submissions.some(submission => submission.revision === chat.draft.revision)
    return { revision: chat.draft.revision, text: sent ? '' : chat.draft.text, skills: sent ? [] : chat.draft.skills, save: 'saved', error: null }
  }

  edit(bridge: PersonalChatBridge, chat: PersonalChat, patch: { readonly text?: string; readonly skills?: readonly AgentSkillReference[] }): void {
    const current = this.draft(chat)
    const previous = this.entries.get(chat.id)
    if (previous?.timer) clearTimeout(previous.timer)
    const entry: Entry = { revision: current.revision + 1, text: patch.text ?? current.text, skills: patch.skills ?? current.skills, save: 'unsaved', error: null, timer: null }
    entry.timer = setTimeout(() => { void this.flush(bridge, chat.id) }, PERSONAL_DRAFT_SAVE_MS)
    this.entries.set(chat.id, entry)
    this.emit()
  }

  /** Writes the latest edit now. Resolves whether it is saved. */
  async flush(bridge: PersonalChatBridge, chatId: string): Promise<boolean> {
    const entry = this.entries.get(chatId)
    if (!entry || entry.save === 'saved') return true
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    const { revision, text, skills } = entry
    entry.save = 'saving'
    this.emit()
    try {
      await bridge.saveDraft({ chatId, revision, text, skills: [...skills] })
      this.settle(chatId, revision, null)
      return true
    } catch (error) {
      this.settle(chatId, revision, personalError(error, 'Sotto could not save this draft.'))
      return false
    }
  }

  /**
   * Saves and sends what the composer holds. Once the chat has the revision, the composer empties
   * unless the reader typed on meanwhile. Resolves an error to show, or null.
   */
  async send(bridge: PersonalChatBridge, chat: PersonalChat): Promise<string | null> {
    const draft = this.draft(chat)
    if (!draft.text.trim()) return null
    if (!await this.flush(bridge, chat.id)) return this.entries.get(chat.id)?.error ?? 'Sotto could not save this draft.'
    try {
      const state = await bridge.send({ chatId: chat.id, revision: draft.revision })
      const sent = state.chats.find(item => item.id === chat.id)
      const latest = this.entries.get(chat.id)
      if (sent && (latest === undefined || latest.revision === draft.revision)) {
        this.entries.delete(chat.id)
        this.edit(bridge, sent, { text: '', skills: [] })
        await this.flush(bridge, chat.id)
      }
      return null
    } catch (error) {
      return personalError(error, 'Sotto could not send this message.')
    }
  }

  /** Whether the composer already holds this submission's text. */
  holds(chat: PersonalChat, submission: Submission): boolean {
    return this.draft(chat).text.includes(submission.text)
  }

  /**
   * Puts a submission that did not go through back in the composer as a newer revision, after anything typed
   * since, with its skills. It is only ever edited here; sending it again is the reader's choice.
   */
  recover(bridge: PersonalChatBridge, chat: PersonalChat, submission: Submission): void {
    if (this.holds(chat, submission)) return
    const current = this.draft(chat)
    const typed = current.text.trimEnd()
    const skills = [...current.skills, ...submission.skills.filter(skill => !current.skills.some(item => item.name === skill.name && item.path === skill.path))]
    this.edit(bridge, chat, { text: typed ? `${typed}

${submission.text}` : submission.text, skills })
    void this.flush(bridge, chat.id)
  }

  private settle(chatId: string, revision: number, error: string | null): void {
    const entry = this.entries.get(chatId)
    if (!entry || entry.revision !== revision) return
    entry.save = error === null ? 'saved' : 'unsaved'
    entry.error = error
    this.emit()
  }

  private emit(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }
}

export const personalDraftStore = new PersonalDraftStore()

export function usePersonalDraft(store: PersonalDraftStore, chat: PersonalChat): PersonalDraftView {
  useSyncExternalStore(store.subscribe, store.snapshot)
  return store.draft(chat)
}
