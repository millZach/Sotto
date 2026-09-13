/// <reference types="vite/client" />
import { renderDiagram } from '../../../src/renderer/src/agents/diagrams/diagramRenderer'
import { readDiagramPalette } from '../../../src/renderer/src/agents/diagrams/diagramPalette'
import { inspectDiagramSource } from '../../../src/renderer/src/agents/diagrams/diagramSource'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageContent } from '../../../src/renderer/src/agents/MessageContent'

export async function probe(source: string, direct = false, timeoutMs?: number) {
  const start = performance.now()
  let tickAt: number | null = null
  const tick = new Promise<void>(resolve => setTimeout(() => {
    tickAt = performance.now() - start
    resolve()
  }, 50))
  let stages = 0
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && node.hasAttribute('data-diagram-stage')) stages++
    }
  })
  observer.observe(document.body, { childList: true })
  const inspection = inspectDiagramSource(source)
  const result = direct ? await renderDiagram(source, readDiagramPalette(), timeoutMs)
    : inspection.problem ? { ok: false as const, reason: inspection.problem }
      : await renderDiagram(inspection.code, readDiagramPalette(), timeoutMs)
  const ms = performance.now() - start
  // Include the actual image-document lifecycle, not only the live measurement stage.
  if (result.ok) {
    const image = new Image()
    image.src = result.dataUrl
    document.body.append(image)
    await image.decode()
    image.remove()
  }
  await tick
  await new Promise(resolve => setTimeout(resolve, 100))
  observer.disconnect()
  return { ok: result.ok, reason: result.ok ? null : result.reason, ms, tickAt, stages,
    remainingStages: document.querySelectorAll('[data-diagram-stage]').length }
}

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
function message(source: string) {
  root.render(createElement(MessageContent, { text: '```mermaid\n' + source + '\n```' }))
}
Object.assign(window, { diagramSafetyProbe: probe, diagramSafetyMessage: message })
