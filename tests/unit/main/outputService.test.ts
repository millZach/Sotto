import { describe, expect, it, vi } from 'vitest'

import {
  OutputService,
  OutputClipboardError,
  createSpawnProcessAdapter,
  type SpawnedProcessLike,
  type OutputServiceDependencies,
} from '../../../src/main/output/outputService'
import type { PasteInvocation } from '../../../src/main/output/pasteCommand'

function createHarness(
  overrides: Partial<OutputServiceDependencies> = {},
): {
  readonly events: string[]
  readonly clipboardText: () => string | undefined
  readonly processInput: () => PasteInvocation | undefined
  readonly service: OutputService
} {
  const events: string[] = []
  let clipboardText: string | undefined
  let processInput: PasteInvocation | undefined
  const dependencies: OutputServiceDependencies = {
    clipboard: {
      writeText(text): void {
        events.push('clipboard')
        clipboardText = text
      },
    },
    widget: {
      hideWidget(): void {
        events.push('hide')
      },
    },
    delay(milliseconds): Promise<void> {
      events.push(`delay:${milliseconds}`)
      return Promise.resolve()
    },
    process: {
      run(invocation): Promise<boolean> {
        events.push('process')
        processInput = invocation
        return Promise.resolve(true)
      },
    },
    ...overrides,
  }

  return {
    events,
    clipboardText: () => clipboardText,
    processInput: () => processInput,
    service: new OutputService(dependencies),
  }
}

describe('OutputService', () => {
  it.each(['', '   ', '\r\n\t'])('ignores empty transcript %j', async (text) => {
    const harness = createHarness()

    await expect(
      harness.service.deliver(text, { autoPaste: true, pasteDelayMs: 80 }),
    ).resolves.toBe('empty')
    expect(harness.events).toEqual([])
    expect(harness.clipboardText()).toBeUndefined()
  })

  it('copies nonempty text exactly without paste work when auto-paste is disabled', async () => {
    const transcript = '  exact text\r\nwith whitespace  '
    const harness = createHarness()

    await expect(
      harness.service.deliver(transcript, { autoPaste: false, pasteDelayMs: 125 }),
    ).resolves.toBe('copied')
    expect(harness.clipboardText()).toBe(transcript)
    expect(harness.events).toEqual(['clipboard'])
  })

  it('rejects clipboard failure with a finite error and performs no paste work', async () => {
    const hideWidget = vi.fn()
    const delay = vi.fn()
    const run = vi.fn()
    const service = new OutputService({
      clipboard: { writeText: () => { throw new Error('secret OS clipboard detail') } },
      widget: { hideWidget },
      delay,
      process: { run },
    })

    await expect(
      service.deliver('private transcript', { autoPaste: true, pasteDelayMs: 10 }),
    ).rejects.toEqual(new OutputClipboardError())
    expect(hideWidget).not.toHaveBeenCalled()
    expect(delay).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('copies, hides, waits the configured delay, then invokes the static paste command', async () => {
    const harness = createHarness()

    await expect(
      harness.service.deliver('dictation', { autoPaste: true, pasteDelayMs: 275 }),
    ).resolves.toBe('pasted')
    expect(harness.events).toEqual(['clipboard', 'hide', 'delay:275', 'process'])
  })

  it('never exposes transcript text to the paste process invocation', async () => {
    const transcript = "secret $env:TOKEN; 'quoted' | Remove-Item * & < >"
    const harness = createHarness()

    await harness.service.deliver(transcript, { autoPaste: true, pasteDelayMs: 0 })

    const invocation = harness.processInput()
    expect(invocation).toBeDefined()
    const script = Buffer.from(invocation?.args[5] ?? '', 'base64').toString('utf16le')
    expect(invocation?.executable).not.toContain(transcript)
    expect(invocation?.args.join(' ')).not.toContain(transcript)
    expect(script).not.toContain(transcript)
    expect(harness.clipboardText()).toBe(transcript)
  })

  it.each([
    ['widget synchronous throw', ['clipboard', 'hide'], (events: string[]) => ({
      widget: { hideWidget: () => { events.push('hide'); throw new Error('private') } },
    })],
    ['widget rejection', ['clipboard', 'hide'], (events: string[]) => ({
      widget: { hideWidget: () => { events.push('hide'); return Promise.reject(new Error('private')) } },
    })],
    ['delay synchronous throw', ['clipboard', 'hide', 'delay:40'], (events: string[]) => ({
      delay: () => { events.push('delay:40'); throw new Error('private') },
    })],
    ['delay rejection', ['clipboard', 'hide', 'delay:40'], (events: string[]) => ({
      delay: () => { events.push('delay:40'); return Promise.reject(new Error('private')) },
    })],
    ['process synchronous throw', ['clipboard', 'hide', 'delay:40', 'process'], (events: string[]) => ({
      process: { run: () => { events.push('process'); throw new Error('private') } },
    })],
    ['process rejection', ['clipboard', 'hide', 'delay:40', 'process'], (events: string[]) => ({
      process: { run: () => { events.push('process'); return Promise.reject(new Error('private')) } },
    })],
    ['unsuccessful process exit', ['clipboard', 'hide', 'delay:40', 'process'], (events: string[]) => ({
      process: { run: () => { events.push('process'); return Promise.resolve(false) } },
    })],
  ] as const)(
    'keeps the clipboard and returns copied after %s',
    async (_scenario, expectedEvents, createOverride) => {
      const events: string[] = []
      const service = new OutputService({
        clipboard: {
          writeText(text): void {
            events.push('clipboard')
            expect(text).toBe('safe clipboard text')
          },
        },
        widget: { hideWidget: () => { events.push('hide') } },
        delay: (milliseconds) => {
          events.push(`delay:${milliseconds}`)
          return Promise.resolve()
        },
        process: {
          run: () => {
            events.push('process')
            return Promise.resolve(true)
          },
        },
        ...createOverride(events),
      })

      await expect(
        service.deliver('safe clipboard text', { autoPaste: true, pasteDelayMs: 40 }),
      ).resolves.toBe('copied')
      expect(events).toEqual(expectedEvents)
    },
  )
})

describe('createSpawnProcessAdapter', () => {
  it('spawns without a shell or stdin and resolves successful exits', async () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const child: SpawnedProcessLike = {
      once(event, listener): SpawnedProcessLike {
        listeners.set(event, listener as (...args: never[]) => void)
        return this
      },
    }
    const spawn = vi.fn(() => child)
    const invocation: PasteInvocation = Object.freeze({
      executable: 'powershell.exe',
      args: Object.freeze(['-EncodedCommand', 'static']),
    })

    const result = createSpawnProcessAdapter(spawn).run(invocation)
    expect(spawn).toHaveBeenCalledWith('powershell.exe', invocation.args, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    listeners.get('exit')?.(0 as never, null as never)

    await expect(result).resolves.toBe(true)
  })

  it.each([
    ['spawn throw', 'throw'],
    ['spawn error', 'error'],
    ['failed exit', 'exit'],
    ['signaled exit', 'signal'],
  ] as const)('resolves false after %s without leaking OS errors', async (_name, failure) => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const spawn = vi.fn((): SpawnedProcessLike => {
      if (failure === 'throw') {
        throw new Error('private OS detail')
      }
      return {
        once(event, listener): SpawnedProcessLike {
          listeners.set(event, listener as (...args: never[]) => void)
          return this
        },
      }
    })
    const adapter = createSpawnProcessAdapter(spawn)
    const result = adapter.run({ executable: 'powershell.exe', args: [] })

    if (failure === 'error') {
      listeners.get('error')?.(new Error('private OS detail') as never)
    } else if (failure === 'exit') {
      listeners.get('exit')?.(1 as never, null as never)
    } else if (failure === 'signal') {
      listeners.get('exit')?.(null as never, 'SIGTERM' as never)
    }

    await expect(result).resolves.toBe(false)
  })

  it('settles once when both error and exit events arrive', async () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const adapter = createSpawnProcessAdapter(() => ({
      once(event, listener): SpawnedProcessLike {
        listeners.set(event, listener as (...args: never[]) => void)
        return this
      },
    }))

    const result = adapter.run({ executable: 'powershell.exe', args: [] })
    listeners.get('error')?.(new Error('private') as never)
    listeners.get('exit')?.(0 as never, null as never)

    await expect(result).resolves.toBe(false)
  })
})
