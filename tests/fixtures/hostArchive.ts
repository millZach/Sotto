// Builds a host release archive the way `npm run package:host` lays one out, a gzipped ustar tar, and serves release
// folders the way the releases page does: `/v<version>/<archive>` beside its `.sha256` sidecar. Host update tests use both.
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'

/** A gzipped tar of these files, every one a regular file; tar makes the folders their paths name. */
export function tarGz(files: Readonly<Record<string, string | Uint8Array>>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, contents] of Object.entries(files)) {
    const body = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : Buffer.from(contents)
    const header = Buffer.alloc(512)
    const field = (value: string, offset: number, length: number): void => { header.write(value, offset, length, 'ascii') }
    const octal = (value: number, offset: number, length: number): void => field(value.toString(8).padStart(length - 1, '0') + '\0', offset, length)
    field(name, 0, 100)
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(body.length, 124, 12); octal(Math.floor(Date.now() / 1000), 136, 12)
    header.fill(' ', 148, 156)
    field('0', 156, 1)
    field('ustar\0', 257, 6); field('00', 263, 2)
    let sum = 0
    for (const byte of header) sum += byte
    field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
/** The `.sha256` sidecar the release procedure publishes beside an archive. */
export const sidecar = (bytes: Uint8Array, file: string): string => `${sha256(bytes)}  ${file}\n`
/** The name `package:host` gives an archive built on this machine. */
export const localArchiveName = (version: string): string => `Sotto-host-${version}-${process.platform}-${process.arch}.tar.gz`

/**
 * The files of a host release: its package.json and runtime manifest, and `host/index.js` from the given source, an ES
 * module unless it says it is CommonJS, as a bundle built for Node is.
 */
export function hostRelease(version: string, entry: string, options: { readonly nodeRange?: string; readonly commonjs?: boolean } = {}): Record<string, string> {
  const major = Number(process.versions.node.split('.')[0])
  return { 'package.json': JSON.stringify({ name: 'sotto-host', version, ...(options.commonjs ? {} : { type: 'module' }) }),
    'runtime-manifest.json': JSON.stringify({ sottoVersion: version, node: options.nodeRange ?? `>=${major} <${major + 1}` }), 'host/index.js': entry }
}

/**
 * A stand-in releases page. `files` maps a path such as `/v1.2.3/<archive>` to its bytes, read on each request so a test
 * can change what it publishes; anything else is a 404. `delayMs` holds each answer back, so a download can be watched,
 * and `hold`, when given, keeps an answer until the promise it returns for that request settles.
 */
export async function releasesPage(files: Map<string, Uint8Array | string>, delayMs = 0, hold?: (request: { readonly method: string; readonly path: string }) => Promise<void> | undefined): Promise<{ readonly url: string; readonly requests: string[]; close(): Promise<void>; server: Server }> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    requests.push(path)
    void Promise.resolve(hold?.({ method: request.method ?? 'GET', path })).then(() => setTimeout(() => {
      const body = files.get(path)
      if (body === undefined) { response.statusCode = 404; response.end('Not Found'); return }
      response.setHeader('content-type', 'application/octet-stream')
      response.end(body)
    }, delayMs))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, requests, server, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
