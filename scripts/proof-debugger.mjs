// Deadline-bound inspector/CDP access for local verification processes.
/* global WebSocket, fetch, AbortSignal */
import { setTimeout, clearTimeout } from 'node:timers'

export async function fetchProofJson(url, timeoutMs = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Debugger discovery failed: ${response.status}`)
  return response.json()
}

export async function openProofDebugger(url, timeoutMs = 5000) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let id = 0
  const fail = error => {
    for (const request of [...pending.values()]) request.reject(error)
  }
  socket.addEventListener('close', () => fail(new Error('Debugger closed')))
  socket.addEventListener('error', () => fail(new Error('Debugger error')))
  socket.addEventListener('message', event => {
    let message
    try { message = JSON.parse(event.data) } catch { fail(new Error('Invalid debugger reply')); return }
    const request = pending.get(message.id)
    if (!request) return
    if (message.error || message.result?.exceptionDetails) {
      request.reject(new Error(message.error?.message ?? message.result?.exceptionDetails?.exception?.description ?? 'Debugger evaluation failed'))
    } else request.resolve(message.result?.result?.value)
  })
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timeout)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
        if (error) reject(error)
        else resolve()
      }
      const onOpen = () => finish()
      const onError = () => finish(new Error('Debugger connection error'))
      const onClose = () => finish(new Error('Debugger closed during connection'))
      const timeout = setTimeout(() => finish(new Error('Debugger connection deadline')), timeoutMs)
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
    })
  } catch (error) {
    socket.close()
    throw error
  }
  return {
    evaluate(expression, deadlineMs = 15000) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Debugger is closed')); return }
        const mine = ++id
        const finish = (error, value) => {
          clearTimeout(timeout)
          pending.delete(mine)
          if (error) reject(error)
          else resolve(value)
        }
        const timeout = setTimeout(() => finish(new Error('Debugger evaluation deadline')), deadlineMs)
        pending.set(mine, { resolve: value => finish(undefined, value), reject: error => finish(error) })
        try {
          socket.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
        } catch (error) { finish(error) }
      })
    },
    close() {
      fail(new Error('Debugger closed by proof'))
      socket.close()
    },
  }
}
