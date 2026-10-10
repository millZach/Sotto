// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  installSessionPermissionPolicy,
  type PermissionCheckHandler,
  type PermissionRequestHandler,
  type SessionPermissionAdapter
} from '../../../../src/main/app/bootstrap'
import { createDeferred } from '../../../fixtures/bootstrapHarness'


describe('permission policy', () => {
  function createAtomicSession() {
    let permissionRequest: PermissionRequestHandler | null = null
    let permissionCheck: PermissionCheckHandler | null = null
    const session: SessionPermissionAdapter = {
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequest = handler
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheck = handler
      }),
    }
    return {
      get permissionCheck() {
        return permissionCheck
      },
      get permissionRequest() {
        return permissionRequest
      },
      session,
    }
  }

  function createSession(): {
    permissionCheck: PermissionCheckHandler
    permissionRequest: PermissionRequestHandler
    session: SessionPermissionAdapter
  } {
    let permissionRequest: PermissionRequestHandler = () => undefined
    let permissionCheck: PermissionCheckHandler = () => false
    const session: SessionPermissionAdapter = {
      setPermissionRequestHandler: vi.fn((handler) => {
        if (handler === null) {
          return
        }
        permissionRequest = handler
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        if (handler === null) {
          return
        }
        permissionCheck = handler
      }),
    }
    return {
      get permissionCheck() {
        return permissionCheck
      },
      get permissionRequest() {
        return permissionRequest
      },
      session,
    }
  }

  it('allows only trusted renderer microphone requests', () => {
    const harness = createSession()
    const packagedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    const developmentContents = { getURL: () => 'http://127.0.0.1:5173/' }
    installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: packagedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
      {
        role: 'main',
        webContents: developmentContents,
        url: 'http://127.0.0.1:5173/',
      },
    ])

    const trustedAudio = vi.fn()
    harness.permissionRequest(
      packagedContents,
      'media',
      trustedAudio,
      {
        isMainFrame: true,
        requestingUrl: 'file:///C:/Sotto/out/renderer/index.html',
        mediaTypes: ['audio'],
      },
    )
    expect(trustedAudio).toHaveBeenCalledWith(true)
    expect(
      harness.permissionCheck(developmentContents, 'media', 'http://127.0.0.1:5173/', {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: 'http://127.0.0.1:5173/',
      }),
    ).toBe(true)
  })

  it('resolves trusted renderer identity at request time after renderer replacement', () => {
    const harness = createSession()
    const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const originalContents = { getURL: () => trustedUrl }
    const replacementContents = { getURL: () => trustedUrl }
    let trustedRenderers = [
      { role: 'main' as const, webContents: originalContents, url: trustedUrl },
    ]
    installSessionPermissionPolicy(harness.session, () => trustedRenderers)

    expect(
      harness.permissionCheck(originalContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(true)

    trustedRenderers = [
      { role: 'main' as const, webContents: replacementContents, url: trustedUrl },
    ]

    expect(
      harness.permissionCheck(originalContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(false)
    expect(
      harness.permissionCheck(replacementContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(true)
  })

  it('denies microphone permission to a trusted widget identity', () => {
    const harness = createSession()
    const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
    const widgetContents = { getURL: () => widgetUrl }
    installSessionPermissionPolicy(harness.session, () => [
      { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
    ])

    expect(
      harness.permissionCheck(widgetContents, 'media', widgetUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: widgetUrl,
      }),
    ).toBe(false)
  })

  it('fails closed when renderer liveness inspection throws', () => {
    const harness = createSession()
    const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const trustedContents = {
      getURL: () => trustedUrl,
      isDestroyed: (): boolean => {
        throw new Error('secret renderer teardown detail')
      },
    }
    installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: trustedContents, url: trustedUrl },
    ])

    expect(() =>
      harness.permissionCheck(trustedContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).not.toThrow()
    expect(
      harness.permissionCheck(trustedContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(false)
  })

  it('rolls back a partial first installation and permits a clean retry', () => {
    const harness = createAtomicSession()
    const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const trustedContents = { getURL: () => trustedUrl }
    vi.mocked(harness.session.setPermissionRequestHandler).mockImplementationOnce(() => {
      throw new Error('secret native setter detail')
    })
    let installError: unknown

    try {
      installSessionPermissionPolicy(harness.session, () => [
        { role: 'main', webContents: trustedContents, url: trustedUrl },
      ])
    } catch (error) {
      installError = error
    }

    expect(installError).toMatchObject({ code: 'PERMISSION_POLICY_INSTALL_FAILED' })
    expect(harness.permissionCheck).toBeNull()
    expect(harness.permissionRequest).toBeNull()

    expect(() =>
      installSessionPermissionPolicy(harness.session, () => [
        { role: 'main', webContents: trustedContents, url: trustedUrl },
      ]),
    ).not.toThrow()
    expect(harness.permissionCheck).not.toBeNull()
    expect(harness.permissionRequest).not.toBeNull()
  })

  it('restores the prior policy when replacement installation fails', () => {
    const harness = createAtomicSession()
    const originalUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const originalContents = { getURL: () => originalUrl }
    const replacementUrl = 'file:///C:/Sotto/out/renderer/replacement.html'
    const replacementContents = { getURL: () => replacementUrl }
    const originalCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: originalContents, url: originalUrl },
    ])
    const originalCheck = harness.permissionCheck
    const originalRequest = harness.permissionRequest
    vi.mocked(harness.session.setPermissionRequestHandler).mockImplementationOnce(() => {
      throw new Error('secret native setter detail')
    })

    expect(() =>
      installSessionPermissionPolicy(harness.session, () => [
        { role: 'main', webContents: replacementContents, url: replacementUrl },
      ]),
    ).toThrow()

    expect(harness.permissionCheck).toBe(originalCheck)
    expect(harness.permissionRequest).toBe(originalRequest)
    expect(
      harness.permissionCheck?.(originalContents, 'media', originalUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: originalUrl,
      }),
    ).toBe(true)
    originalCleanup()
  })

  it('restores nested ownership in order and stale cleanup never clears a newer policy', () => {
    const harness = createAtomicSession()
    const originalUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const originalContents = { getURL: () => originalUrl }
    const replacementUrl = 'file:///C:/Sotto/out/renderer/replacement.html'
    const replacementContents = { getURL: () => replacementUrl }
    const originalCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: originalContents, url: originalUrl },
    ])
    const originalCheck = harness.permissionCheck
    const replacementCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: replacementContents, url: replacementUrl },
    ])
    const replacementCheck = harness.permissionCheck

    originalCleanup()
    expect(harness.permissionCheck).toBe(replacementCheck)

    replacementCleanup()
    expect(harness.permissionCheck).toBeNull()
    expect(harness.permissionRequest).toBeNull()

    const restoredOriginalCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: originalContents, url: originalUrl },
    ])
    const nestedCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: replacementContents, url: replacementUrl },
    ])
    nestedCleanup()
    expect(harness.permissionCheck).not.toBe(replacementCheck)
    expect(harness.permissionCheck).not.toBeNull()
    restoredOriginalCleanup()
    expect(harness.permissionCheck).toBeNull()
    expect(originalCheck).not.toBeNull()
  })

  it('resets only its two permission handlers during idempotent cleanup', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    const cleanup = installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: trustedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])

    cleanup()
    cleanup()

    expect(harness.session.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
    expect(harness.session.setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
  })

  it.each([
    ['untrusted audio', 'media', 'https://attacker.invalid/', ['audio']],
    ['trusted video', 'media', 'file:///C:/Sotto/out/renderer/index.html', ['video']],
    ['trusted display capture', 'display-capture', 'file:///C:/Sotto/out/renderer/index.html', []],
    ['trusted notifications', 'notifications', 'file:///C:/Sotto/out/renderer/index.html', []],
    ['trusted clipboard read', 'clipboard-read', 'file:///C:/Sotto/out/renderer/index.html', []],
  ])('denies %s', (_name, permission, requestingUrl, mediaTypes) => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    const untrustedContents = { getURL: () => 'https://attacker.invalid/' }
    installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: trustedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])
    const callback = vi.fn()

    harness.permissionRequest(
      requestingUrl.includes('attacker') ? untrustedContents : trustedContents,
      permission,
      callback,
      { isMainFrame: true, requestingUrl, mediaTypes },
    )

    expect(callback).toHaveBeenCalledWith(false)
  })

  it.each([
    ['a subframe', { isMainFrame: false, mediaTypes: ['audio'] }],
    ['missing frame details', { mediaTypes: ['audio'] }],
    ['missing media details', { isMainFrame: true }],
    ['mixed audio and video', { isMainFrame: true, mediaTypes: ['audio', 'video'] }],
  ])('denies trusted media from %s', (_name, detailOverrides) => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: trustedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, {
      requestingUrl: 'file:///C:/Sotto/out/renderer/index.html',
      ...detailOverrides,
    })

    expect(callback).toHaveBeenCalledWith(false)
  })

  const gatedUrl = 'file:///C:/Sotto/out/renderer/index.html'
  const gatedRequest = {
    isMainFrame: true,
    requestingUrl: gatedUrl,
    mediaTypes: ['audio'],
  }

  it('does not pre-grant microphone checks until the operating system has granted them', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      async () => true,
      () => false,
    )

    expect(
      harness.permissionCheck(trustedContents, 'media', gatedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: gatedUrl,
      }),
    ).toBe(false)
  })

  it('pre-grants microphone checks only after the operating system has granted them', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      async () => true,
      () => true,
    )

    expect(
      harness.permissionCheck(trustedContents, 'media', gatedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: gatedUrl,
      }),
    ).toBe(true)
  })

  it('grants synchronously when no media gate is configured', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      undefined,
    )
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, gatedRequest)

    expect(callback).toHaveBeenCalledWith(true)
  })

  it('grants a trusted microphone request only after the media gate allows it', async () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    const gate = createDeferred<boolean>()
    const mediaAccess = vi.fn(() => gate.promise)
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      mediaAccess,
    )
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, gatedRequest)
    expect(callback).not.toHaveBeenCalled()
    gate.resolve(true)

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true))
    expect(mediaAccess).toHaveBeenCalledOnce()
  })

  it('denies an otherwise valid microphone request the media gate refuses', async () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      async () => false,
    )
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, gatedRequest)

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false))
  })

  it('never consults the media gate for an untrusted request', async () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    const untrustedContents = { getURL: () => 'https://attacker.invalid/' }
    const mediaAccess = vi.fn(async () => true)
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      mediaAccess,
    )
    const callback = vi.fn()

    harness.permissionRequest(untrustedContents, 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'https://attacker.invalid/',
      mediaTypes: ['audio'],
    })

    expect(callback).toHaveBeenCalledWith(false)
    expect(mediaAccess).not.toHaveBeenCalled()
  })

  it('denies when the requesting renderer is destroyed while the gate prompts', async () => {
    const harness = createSession()
    let destroyed = false
    const trustedContents = { getURL: () => gatedUrl, isDestroyed: () => destroyed }
    const gate = createDeferred<boolean>()
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      () => gate.promise,
    )
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, gatedRequest)
    destroyed = true
    gate.resolve(true)

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false))
  })

  it('denies when the trusted renderer is replaced while the gate prompts', async () => {
    const harness = createSession()
    const originalContents = { getURL: () => gatedUrl }
    const replacementContents = { getURL: () => gatedUrl }
    let trustedRenderers = [
      { role: 'main' as const, webContents: originalContents, url: gatedUrl },
    ]
    const gate = createDeferred<boolean>()
    installSessionPermissionPolicy(
      harness.session,
      () => trustedRenderers,
      () => gate.promise,
    )
    const callback = vi.fn()

    harness.permissionRequest(originalContents, 'media', callback, gatedRequest)
    trustedRenderers = [
      { role: 'main' as const, webContents: replacementContents, url: gatedUrl },
    ]
    gate.resolve(true)

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false))
  })

  it('denies without leaking a rejected media gate', async () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      async () => {
        throw new Error('secret TCC failure C:/Users/private')
      },
    )
    const callback = vi.fn()

    expect(() =>
      harness.permissionRequest(trustedContents, 'media', callback, gatedRequest),
    ).not.toThrow()

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false))
  })

  it('checks a trusted microphone request against the OS grant', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    let granted = false
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      async () => true,
      () => granted,
    )
    const check = (): boolean => harness.permissionCheck(trustedContents, 'media', gatedUrl, {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: gatedUrl,
    })

    expect(check()).toBe(false)
    granted = true
    expect(check()).toBe(true)
  })

  it('fails closed when the OS grant cannot be read, so the check never pre-grants', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => gatedUrl }
    installSessionPermissionPolicy(
      harness.session,
      () => [{ role: 'main', webContents: trustedContents, url: gatedUrl }],
      async () => true,
      () => {
        throw new Error('secret TCC failure C:/Users/private')
      },
    )

    expect(harness.permissionCheck(trustedContents, 'media', gatedUrl, {
      isMainFrame: true,
      mediaType: 'audio',
      requestingUrl: gatedUrl,
    })).toBe(false)
  })
})
