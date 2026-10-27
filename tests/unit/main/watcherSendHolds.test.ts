import { describe, expect, it } from 'vitest'
import { NO_TURN_TO_STEER, queueHold, RUNNING_TURN_HOLD, SLASH_COMMAND_REFUSAL, startsWithSlashCommand, UNCONFIRMED_SEND_HOLD, UNCONFIRMED_SEND_WAITS, USER_TURN_RUNNING, WATCH_PAUSED_HOLD } from '../../../src/main/agents/watcherSendHolds'

describe('what a refused Watcher send says it waits on (#1203)', () => {
  it('names a different hold for each reason, and never background work as one', () => {
    const said = [RUNNING_TURN_HOLD, NO_TURN_TO_STEER, USER_TURN_RUNNING, WATCH_PAUSED_HOLD, queueHold('pending-work', false), queueHold('pending-work', true),
      queueHold('paused-followups', false), queueHold('failed-followups', false), queueHold('uncertain-send', false), UNCONFIRMED_SEND_WAITS]
    expect(new Set(said).size).toBe(said.length)
    for (const text of said) expect(text).toMatch(/Nothing was sent\.$/u)
    expect(said.filter(text => /background/u.test(text))).toEqual([NO_TURN_TO_STEER])
    expect(NO_TURN_TO_STEER).toContain('does not hold a send')
  })

  it('says an unconfirmed earlier send holds it, and how the user ends that, apart from the user’s running turn (#1222)', () => {
    expect(queueHold('uncertain-send', false)).toBe(UNCONFIRMED_SEND_HOLD)
    expect(UNCONFIRMED_SEND_HOLD).toContain('Continue with a new message')
    expect(UNCONFIRMED_SEND_HOLD).not.toMatch(/turn/u)
    // Where the user cannot set it aside, it names no action they cannot take.
    expect(UNCONFIRMED_SEND_WAITS).not.toContain('Continue with a new message')
    expect(UNCONFIRMED_SEND_WAITS).not.toMatch(/turn/u)
    expect(USER_TURN_RUNNING).not.toMatch(/unconfirmed/u)
    // A pause held by something else names no turn, since none is running.
    expect(WATCH_PAUSED_HOLD).not.toMatch(/turn/u)
  })
})

describe('a prompt that starts with a slash command (#1222)', () => {
  it('is one whose first word is a slash and a name, with or without more words after it', () => {
    for (const text of ['/compact', '/compact now', '  /compact', '/review-pr_2 please', '/compact\nkeep the plan', '/my-plugin:review', '/my-plugin:review this branch']) expect(startsWithSlashCommand(text), text).toBe(true)
  })

  it('is not a path, a slash later in the prompt, or a slash alone', () => {
    for (const text of ['/home/x is the path', '/tmp/foo', 'see /tmp/foo', 'Run /compact when you can', '/', '/ compact', '//compact', '']) expect(startsWithSlashCommand(text), text).toBe(false)
  })

  it('is refused in plain words that send the user to run it', () => {
    expect(SLASH_COMMAND_REFUSAL).toMatch(/Ask the user to run it in the thread/u)
    expect(SLASH_COMMAND_REFUSAL).toMatch(/Nothing was sent\.$/u)
  })
})
