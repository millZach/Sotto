import { deflateSync } from 'node:zlib'

/**
 * Real, tiny PDFs built in the test: a page tree of blank pages with a cross-reference table whose offsets are right,
 * so a PDF reader opens them. `objectStreamPdf` keeps its page tree in a compressed object stream, as PDF 1.5 allows,
 * so its page count cannot be read without inflating it.
 */

/** A PDF of `pages` blank 72-point pages, its page tree uncompressed. `encrypted` adds an `/Encrypt` entry to the trailer. */
export function tinyPdf(pages: number, options: { encrypted?: boolean } = {}): Buffer {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>'),
  ]
  let body = '%PDF-1.4\n%âãÏÓ\n'
  const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${options.encrypted ? ' /Encrypt << /Filter /Standard /V 1 /R 2 >>' : ''} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** A one-page PDF 1.5 whose catalog, page tree and page sit in a compressed object stream, found by a cross-reference stream. */
export function objectStreamPdf(): Buffer {
  const packed = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>']
  let header = ''; let objects = ''
  packed.forEach((object, index) => { header += `${index + 1} ${Buffer.byteLength(objects, 'latin1')} `; objects += `${object}\n` })
  const stream = deflateSync(Buffer.from(header + objects, 'latin1'))
  const chunks: Buffer[] = [Buffer.from('%PDF-1.5\n%âãÏÓ\n', 'latin1')]
  const length = (): number => chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const objectStreamAt = length()
  chunks.push(Buffer.from(`4 0 obj\n<< /Type /ObjStm /N 3 /First ${Buffer.byteLength(header, 'latin1')} /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\n', 'latin1'))
  const xrefAt = length()
  // W [1 4 2]: type, then offset or object stream number, then generation or index in that stream.
  const row = (type: number, field: number, index: number): Buffer => { const bytes = Buffer.alloc(7); bytes.writeUInt8(type, 0); bytes.writeUInt32BE(field, 1); bytes.writeUInt16BE(index, 5); return bytes }
  const table = deflateSync(Buffer.concat([row(0, 0, 65535), row(2, 4, 0), row(2, 4, 1), row(2, 4, 2), row(1, objectStreamAt, 0), row(1, xrefAt, 0)]))
  chunks.push(Buffer.from(`5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${table.length} >>\nstream\n`, 'latin1'), table,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(chunks)
}
