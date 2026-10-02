import http from 'node:http'

import { ID_PATTERN } from './config.mjs'
import { debug } from './log.mjs'
import { Channel, ReplayGuard, newNonce, open, seal } from './seal.mjs'

export const PeerOp = Object.freeze({
  Hello: 'hello',
  Manifest: 'manifest',
  Pull: 'pull',
  Offer: 'offer',
  Push: 'push',
  Bundle: 'bundle',
  InstallBundle: 'installBundle',
})

const PROTOCOL_VERSION = 1
const MAX_REQUEST_BYTES = 96 * 1024 * 1024
const MAX_PLAIN_BYTES = 256 * 1024 * 1024
const FAILURE_WINDOW_MS = 60 * 1000
const MAX_FAILURES_PER_WINDOW = 30

export class PeerError extends Error {}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', chunk => {
      total += chunk.length
      if (total > limit) {
        request.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

// The only door other machines get: POST /link with a sealed request. Anything
// that does not open with the link key is answered with a bare 401, and an
// address that keeps failing is turned away for a minute.
export function startPeerServer({ config, key, handlers }) {
  const guard = new ReplayGuard()
  const failures = new Map()

  const isThrottled = address => {
    const entry = failures.get(address)
    if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) {
      return false
    }
    return entry.count >= MAX_FAILURES_PER_WINDOW
  }
  const noteFailure = address => {
    const entry = failures.get(address)
    if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) {
      failures.set(address, { count: 1, since: Date.now() })
      return
    }
    entry.count += 1
  }

  const handle = async (request, response) => {
    const address = request.socket.remoteAddress ?? ''
    if (isThrottled(address)) {
      response.writeHead(429)
      response.end()
      return
    }
    if (request.method !== 'POST' || request.url !== '/link') {
      response.writeHead(404)
      response.end()
      return
    }
    const body = await readBody(request, MAX_REQUEST_BYTES)
    const envelope = body ? open(key, Channel.Request, body, MAX_PLAIN_BYTES) : null
    const isAuthentic = envelope?.v === PROTOCOL_VERSION && ID_PATTERN.test(envelope.from ?? '') && guard.accept(envelope.nonce, envelope.ts)
    if (!isAuthentic || envelope.from === config.machineId) {
      noteFailure(address)
      response.writeHead(401)
      response.end()
      return
    }
    const handler = handlers[envelope.op]
    let reply = { v: PROTOCOL_VERSION, re: envelope.nonce, ok: false, error: 'Unknown operation' }
    if (handler) {
      try {
        reply = { v: PROTOCOL_VERSION, re: envelope.nonce, ok: true, result: await handler(envelope.args ?? {}, { from: envelope.from }) }
      } catch (error) {
        reply = { v: PROTOCOL_VERSION, re: envelope.nonce, ok: false, error: error.message }
      }
    }
    const sealed = seal(key, Channel.Response, reply)
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': sealed.length })
    response.end(sealed)
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      debug.warn('Peer request failed:', error)
      if (!response.headersSent) {
        response.writeHead(500)
      }
      response.end()
    })
  })
  server.requestTimeout = 5 * 60 * 1000
  server.listen(config.peerPort, config.peerHost)
  return server
}

export async function callPeer({ url, key, selfId, op, args, timeoutMs, headers }) {
  const nonce = newNonce()
  const body = seal(key, Channel.Request, { v: PROTOCOL_VERSION, op, ts: Date.now(), nonce, from: selfId, args })
  let response = null
  try {
    response = await fetch(new URL('/link', url), {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/octet-stream', ...(headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : (error.cause?.code ?? error.message)
    throw new PeerError(`could not reach ${url} (${reason})`)
  }
  if (!response.ok) {
    throw new PeerError(`${url} answered HTTP ${response.status}${response.status === 401 ? ' (different link key?)' : ''}`)
  }
  const reply = open(key, Channel.Response, Buffer.from(await response.arrayBuffer()), MAX_PLAIN_BYTES)
  if (!reply || reply.re !== nonce) {
    throw new PeerError(`${url} did not answer with this link key`)
  }
  if (!reply.ok) {
    throw new PeerError(reply.error || 'the other machine reported an error')
  }
  return reply.result
}
