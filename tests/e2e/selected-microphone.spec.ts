import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

interface MediaFixture {
  requests: MediaStreamConstraints[]
  streams: MediaStream[]
  release?: () => void
  context: AudioContext
  audible: boolean
}
declare global { interface Window { selectedMicrophoneFixture: MediaFixture } }

test('Settings tests the selected input and clears its result when the choice changes', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  const evidence = evidenceDirectory('artifacts/review-383')
  await mkdir(evidence, { recursive: true })
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, microphoneId: 'headset', reducedMotion: 'on' })
    })
    await page.reload()
    // Real browser MediaStreams and AudioContext; only discovery/permission use synthetic devices.
    await page.evaluate(() => {
      const fixture: MediaFixture = { requests: [], streams: [], context: new AudioContext(), audible: true }
      window.selectedMicrophoneFixture = fixture
      navigator.mediaDevices.enumerateDevices = async () => ['headset', 'desk', 'missing', 'denied', 'held'].map(id => ({
        deviceId: id, groupId: 'synthetic', kind: 'audioinput' as const, label: `Test ${id}`, toJSON: () => ({}),
      }))
      navigator.mediaDevices.getUserMedia = async constraints => {
        fixture.requests.push(constraints!)
        const audio = constraints!.audio as MediaTrackConstraints
        const id = (audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact
        if (id === 'missing') throw new DOMException('Synthetic missing device', 'NotFoundError')
        if (id === 'denied') throw new DOMException('Synthetic denial', 'NotAllowedError')
        if (id === 'held') await new Promise<void>(resolve => { fixture.release = resolve })
        const destination = fixture.context.createMediaStreamDestination()
        if (fixture.audible) {
          const oscillator = fixture.context.createOscillator()
          const gain = fixture.context.createGain()
          gain.gain.value = 0.05
          oscillator.connect(gain).connect(destination)
          oscillator.start()
        }
        const stream = destination.stream
        fixture.streams.push(stream)
        return stream
      }
    })
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    const choice = page.getByLabel('Microphone', { exact: true })
    const state = page.locator('.settings-microphone-test')
    const run = () => page.getByRole('button', { name: 'Test microphone', exact: true }).click()
    await run()
    await expect(state).toHaveAttribute('data-state', 'ready')
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.requests.at(-1))).toMatchObject({ audio: { deviceId: { exact: 'headset' } } })

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect(choice).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Stop test' })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: resolve(evidence, `microphone-${width}-${appearance}.png`) })
      }
    }
    await expect.poll(async () => Number(await page.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow'))).toBeGreaterThan(0.02)
    await page.getByRole('button', { name: 'Stop test' }).focus()
    await page.keyboard.press('Enter')
    await expect(state).toHaveAttribute('data-state', 'closed')
    await expect(state).toContainText('Sotto heard you. The microphone is closed.')
    await expect(page.getByRole('button', { name: 'Test again' })).toBeEnabled()
    await page.screenshot({ path: resolve(evidence, 'microphone-closed.png') })
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.streams[0]!.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
    await page.evaluate(() => { window.selectedMicrophoneFixture.audible = false })
    await page.getByRole('button', { name: 'Test again' }).click()
    await expect(state).toHaveAttribute('data-state', 'ready')
    await page.getByRole('button', { name: 'Stop test' }).click()
    await expect(state).toContainText('Sotto did not hear anything. Check that the microphone is not muted.')
    await page.screenshot({ path: resolve(evidence, 'microphone-silent.png') })
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.streams.at(-1)!.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
    await page.getByRole('button', { name: 'Test again' }).click()
    await expect(state).toHaveAttribute('data-state', 'ready')
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.hide())
    await expect(state).toHaveAttribute('data-state', 'closed')
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.show())
    await choice.selectOption('desk')
    await expect(state).toHaveAttribute('data-state', 'idle')
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.streams[0]!.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
    await run()
    await expect(state).toHaveAttribute('data-state', 'ready')
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.requests.at(-1))).toMatchObject({ audio: { deviceId: { exact: 'desk' } } })
    await page.evaluate(() => window.selectedMicrophoneFixture.streams.at(-1)!.getTracks()[0]!.dispatchEvent(new Event('ended')))
    await expect(state).toHaveAttribute('data-state', 'missing')
    await expect(state).toContainText('No microphone was found.')
    await page.evaluate(() => {
      navigator.mediaDevices.enumerateDevices = async () => ['headset', 'missing', 'denied', 'held'].map(id => ({
        deviceId: id, groupId: 'synthetic', kind: 'audioinput' as const, label: `Test ${id}`, toJSON: () => ({}),
      }))
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    await expect(state).toContainText('The chosen microphone is not connected. Plug it in or choose another.')
    expect(await page.evaluate(() => window.selectedMicrophoneFixture.streams.at(-1)!.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
    await page.screenshot({ path: resolve(evidence, 'microphone-unplugged.png') })
    for (const id of ['missing', 'denied']) {
      await choice.selectOption(id)
      await expect(state).toHaveAttribute('data-state', 'idle')
      await run()
      await expect(state).toHaveAttribute('data-state', id)
      await page.getByRole('tab', { name: 'Output', exact: true }).click()
      await page.getByRole('tab', { name: 'Dictation', exact: true }).click()
      await expect(state).toHaveAttribute('data-state', id)
    }
    await choice.selectOption('held')
    await expect(state).toHaveAttribute('data-state', 'idle')
    await run()
    await expect(state).toHaveAttribute('data-state', 'requesting')
    await choice.selectOption('')
    await expect(state).toHaveAttribute('data-state', 'idle')
    await page.evaluate(() => window.selectedMicrophoneFixture.release!())
    await expect.poll(() => page.evaluate(() => window.selectedMicrophoneFixture.streams.at(-1)!.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
    await expect(state).toHaveAttribute('data-state', 'idle')
    await run()
    await expect(state).toHaveAttribute('data-state', 'ready')
    expect(await page.evaluate(() => (window.selectedMicrophoneFixture.requests.at(-1)!.audio as MediaTrackConstraints).deviceId)).toBeUndefined()
    await page.getByRole('link', { name: 'History', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.selectedMicrophoneFixture.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
    await page.evaluate(() => window.selectedMicrophoneFixture.context.close())
  } finally { await closeSotto(launched) }
})
