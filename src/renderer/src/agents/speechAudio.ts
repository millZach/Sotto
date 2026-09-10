/** Bound each neural synthesis request without dropping the remainder of a long reply. */
export function splitSpeechText(text: string, limit = 240): string[] {
  const words = text.trim().split(/\s+/u)
  const chunks: string[] = []
  let chunk = ''
  for (const word of words) {
    if (chunk && chunk.length + word.length + 1 > limit) { chunks.push(chunk); chunk = '' }
    // Generated identifiers can be longer than an entire spoken sentence.
    for (let offset = 0; offset < word.length; offset += limit) {
      const part = word.slice(offset, offset + limit)
      if (chunk && chunk.length + part.length + 1 > limit) { chunks.push(chunk); chunk = '' }
      chunk += `${chunk ? ' ' : ''}${part}`
    }
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

export function encodeSpeechWave(parts: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, length * 2, true)
  let offset = 44
  for (const part of parts) for (const sample of part) { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true); offset += 2 }
  return buffer
}
