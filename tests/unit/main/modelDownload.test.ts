import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHttpsDownloader, replaceDirectoryAtomic, validateDownloadRedirect, type HttpsGet } from '../../../src/main/models/modelDownload'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('atomic model promotion', () => {
  it('restores the prior directory when promotion fails after backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-promotion-')); roots.push(root)
    const destination = join(root, 'model')
    const temporary = join(root, 'partial')
    await mkdir(destination); await mkdir(temporary)
    await writeFile(join(destination, 'prior'), 'preserved')
    await writeFile(join(temporary, 'next'), 'verified')
    let renameCalls = 0

    await expect(replaceDirectoryAtomic(temporary, destination, {
      rename: async (from, to) => {
        renameCalls += 1
        if (renameCalls === 2) throw new Error('promotion denied')
        await rename(from, to)
      },
      rm,
      exists: async (path) => readdir(path).then(() => true, () => false),
    })).rejects.toThrow('Model promotion failed')

    await expect(readFile(join(destination, 'prior'), 'utf8')).resolves.toBe('preserved')
    await expect(readFile(join(destination, 'next'))).rejects.toThrow()
  })

  it('treats backup cleanup failure as best effort after successful promotion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-promotion-')); roots.push(root)
    const destination = join(root, 'model')
    const temporary = join(root, 'partial')
    await mkdir(destination); await mkdir(temporary)
    await writeFile(join(destination, 'prior'), 'old')
    await writeFile(join(temporary, 'next'), 'verified')

    await expect(replaceDirectoryAtomic(temporary, destination, {
      rename,
      rm: async () => { throw new Error('cleanup denied') },
      exists: async (path) => readdir(path).then(() => true, () => false),
    })).resolves.toBeUndefined()

    await expect(readFile(join(destination, 'next'), 'utf8')).resolves.toBe('verified')
    await expect(readFile(join(destination, 'prior'))).rejects.toThrow()
  })
})

describe('download redirect policy', () => {
  it('permits only bounded HTTPS redirects to the explicit Hugging Face delivery hosts', () => {
    expect(validateDownloadRedirect('https://huggingface.co/a', '/signed', 0).hostname).toBe('huggingface.co')
    expect(validateDownloadRedirect('https://huggingface.co/a', 'https://us.aws.cdn.hf.co/signed', 4).hostname).toBe('us.aws.cdn.hf.co')
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'http://us.aws.cdn.hf.co/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'https://evil.invalid/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'https://user:secret@cdn-lfs.huggingface.co/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'https://cdn-lfs.huggingface.co:444/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', '/loop', 5)).toThrow()
  })

  it('streams an approved bounded redirect response to a private destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'partial', 'model.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/model', { status: 302, location: 'https://cdn-lfs.huggingface.co/signed' }],
      ['https://cdn-lfs.huggingface.co/signed', { status: 200, chunks: [Buffer.from('verified')] }],
    ]))

    await createHttpsDownloader(get)('https://huggingface.co/model', destination, 8)

    await expect(readFile(destination, 'utf8')).resolves.toBe('verified')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('destroys a redirect body before issuing the next request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'redirect.bin')
    const redirectResponse = idleResponse(302, { location: 'https://cdn-lfs.huggingface.co/signed' })
    const redirectDestroy = vi.spyOn(redirectResponse, 'destroy')
    let calls = 0
    const get = vi.fn((url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
      calls += 1
      const request = fakeRequest()
      queueMicrotask(() => {
        if (calls === 1) {
          callback(redirectResponse)
          return
        }
        expect(url.href).toBe('https://cdn-lfs.huggingface.co/signed')
        expect(redirectDestroy).toHaveBeenCalledOnce()
        callback(dataResponse(200, Buffer.from('verified')))
      })
      return request
    })

    await createHttpsDownloader(get)('https://huggingface.co/model', destination, 8)

    expect(redirectResponse.destroyed).toBe(true)
  })

  it('destroys a rejected slow response before later chunks can arrive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'mismatch.bin')
    const response = idleResponse(200, { 'content-length': '11' })
    const destroy = vi.spyOn(response, 'destroy')
    let accepted!: () => void
    const responseAccepted = new Promise<void>((resolve) => { accepted = resolve })
    const get = vi.fn((_url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
      const request = fakeRequest()
      queueMicrotask(() => { callback(response); accepted() })
      return request
    })

    const attempt = createHttpsDownloader(get)('https://huggingface.co/model', destination, 10)
    await responseAccepted

    expect(destroy).toHaveBeenCalledOnce()
    expect(response.destroyed).toBe(true)
    await expect(attempt).rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it.each([
    ['redirect without a location', idleResponse(302)],
    ['non-success status', idleResponse(503)],
  ] as const)('destroys the response and request for a %s', async (_name, response) => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'rejected.bin')
    const request = fakeRequest()
    const responseDestroy = vi.spyOn(response, 'destroy')
    const get = vi.fn((_url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
      queueMicrotask(() => callback(response))
      return request
    })

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')

    expect(responseDestroy).toHaveBeenCalledOnce()
    expect(request.destroy).toHaveBeenCalledOnce()
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('bounds a synchronous request creation failure and removes the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'request-throw.bin')
    const get = vi.fn((): ReturnType<HttpsGet> => { throw new Error('request denied') })

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')

    await expect(readFile(destination)).rejects.toThrow()
  })

  it('destroys the request when timeout setup throws synchronously', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'timeout-throw.bin')
    const request = fakeRequest()
    const response = idleResponse(200)
    const responseDestroy = vi.spyOn(response, 'destroy')
    request.setTimeout = vi.fn(() => { throw new Error('timeout denied') })
    const get = vi.fn((_url: URL, callback: Parameters<HttpsGet>[1]) => {
      callback(response)
      return request
    })

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')

    expect(request.destroy).toHaveBeenCalledOnce()
    expect(responseDestroy).toHaveBeenCalledOnce()
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('supports a response callback that runs synchronously during request creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'synchronous.bin')
    const get = vi.fn((_url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
      const request = fakeRequest()
      callback(dataResponse(200, Buffer.from('verified')))
      return request
    })

    await createHttpsDownloader(get)('https://huggingface.co/model', destination, 8)

    await expect(readFile(destination, 'utf8')).resolves.toBe('verified')
  })

  it('rejects redirect loops and removes the partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/a', { status: 302, location: 'https://cdn-lfs.huggingface.co/b' }],
      ['https://cdn-lfs.huggingface.co/b', { status: 302, location: 'https://huggingface.co/a' }],
    ]))

    await expect(createHttpsDownloader(get)('https://huggingface.co/a', destination, 100))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('enforces the locked byte maximum while streaming and removes partial output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/model', { status: 200, chunks: [Buffer.alloc(5), Buffer.alloc(6)] }],
    ]))

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('rejects a response shorter than the exact locked byte count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/model', { status: 200, chunks: [Buffer.alloc(9)] }],
    ]))

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('enforces an overall wall-clock deadline even while the request is not idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = vi.fn((...args: Parameters<HttpsGet>): ReturnType<HttpsGet> => {
      expect(args).toHaveLength(2)
      const request = new EventEmitter() as EventEmitter & {
        setTimeout(milliseconds: number, callback: () => void): void
        once(event: 'error', callback: (error: Error) => void): unknown
        destroy(error: Error): void
      }
      request.setTimeout = vi.fn()
      request.destroy = (error) => request.emit('error', error)
      return request
    })
    const clear = vi.fn()
    const attempt = createHttpsDownloader(get, {
      requestMs: 1_000,
      overallMs: 50,
      timer: {
        set(callback, milliseconds) { expect(milliseconds).toBe(50); queueMicrotask(callback); return 'deadline' },
        clear,
      },
    })('https://huggingface.co/model', destination, 10)

    await expect(attempt).rejects.toThrow('Model download failed')
    expect(clear).toHaveBeenCalledWith('deadline')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('destroys an accepted in-flight response when the overall deadline expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'deadline-body.bin')
    const response = idleResponse(200)
    const destroy = vi.spyOn(response, 'destroy')
    let deadline!: () => void
    let accepted!: () => void
    const responseAccepted = new Promise<void>((resolve) => { accepted = resolve })
    const get = vi.fn((_url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
      const request = fakeRequest()
      queueMicrotask(() => { callback(response); accepted() })
      return request
    })
    const attempt = createHttpsDownloader(get, {
      overallMs: 50,
      timer: { set(callback) { deadline = callback; return 'deadline' }, clear: vi.fn() },
    })('https://huggingface.co/model', destination, 10)
    await responseAccepted

    deadline()

    expect(destroy).toHaveBeenCalledOnce()
    expect(response.destroyed).toBe(true)
    await expect(attempt).rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('destroys a response delivered after the overall deadline has settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'late-body.bin')
    const response = idleResponse(200)
    const destroy = vi.spyOn(response, 'destroy')
    let deadline!: () => void
    let callback!: Parameters<HttpsGet>[1]
    const request = fakeRequest()
    const get = vi.fn((_url: URL, responseCallback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
      callback = responseCallback
      return request
    })
    const attempt = createHttpsDownloader(get, {
      overallMs: 50,
      timer: { set(next) { deadline = next; return 'deadline' }, clear: vi.fn() },
    })('https://huggingface.co/model', destination, 10)
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())

    deadline()
    await expect(attempt).rejects.toThrow('Model download failed')
    callback(response)

    expect(destroy).toHaveBeenCalledOnce()
    expect(response.destroyed).toBe(true)
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('times out stalled requests and removes partial output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = vi.fn((...args: Parameters<HttpsGet>): ReturnType<HttpsGet> => {
      expect(args).toHaveLength(2)
      const request = new EventEmitter() as EventEmitter & {
        setTimeout(milliseconds: number, callback: () => void): void
        destroy(error: Error): void
      }
      request.setTimeout = (milliseconds, callback) => {
        expect(milliseconds).toBe(30_000)
        queueMicrotask(callback)
      }
      request.destroy = (error) => request.emit('error', error)
      return request
    })

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })
})

interface FakeResponse {
  readonly status: number
  readonly location?: string
  readonly chunks?: readonly Buffer[]
}

function fakeRequest(): ReturnType<HttpsGet> {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout(milliseconds: number, callback: () => void): void
    destroy(error?: Error): void
  }
  request.setTimeout = vi.fn()
  request.destroy = vi.fn()
  return request
}

function idleResponse(statusCode: number, headers: { location?: string; 'content-length'?: string } = {}) {
  const response = new Readable({ read() { /* remains pending until explicitly destroyed */ } }) as Readable & {
    statusCode?: number
    headers: { location?: string; 'content-length'?: string }
  }
  response.statusCode = statusCode
  response.headers = headers
  return response
}

function dataResponse(statusCode: number, content: Buffer) {
  const response = Readable.from([content]) as Readable & {
    statusCode?: number
    headers: { location?: string; 'content-length'?: string }
  }
  response.statusCode = statusCode
  response.headers = {}
  return response
}

function fakeHttpsGet(routes: ReadonlyMap<string, FakeResponse>) {
  return vi.fn((url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout(milliseconds: number, callback: () => void): void
      destroy(error: Error): void
    }
    request.setTimeout = vi.fn()
    request.destroy = (error) => request.emit('error', error)
    queueMicrotask(() => {
      const route = routes.get(url.href)
      if (route === undefined) {
        request.emit('error', new Error('unexpected URL'))
        return
      }
      const response = Readable.from(route.chunks ?? []) as Readable & {
        statusCode?: number
        headers: { location?: string; 'content-length'?: string }
      }
      response.statusCode = route.status
      response.headers = route.location === undefined ? {} : { location: route.location }
      callback(response)
    })
    return request
  })
}
