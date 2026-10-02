import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

// Every message between linked machines is gzipped JSON sealed with
// AES-256-GCM under a key derived from the shared link key. A message that
// fails to open was not made by a paired machine and is dropped.
const FORMAT_VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const MIN_LINK_KEY_BYTES = 32

export const Channel = Object.freeze({
  Request: 'request',
  Response: 'response',
  Beacon: 'beacon',
})

export function deriveKey(linkKey) {
  const secret = Buffer.from(linkKey ?? '', 'base64url')
  if (secret.length < MIN_LINK_KEY_BYTES) {
    throw new Error('The link key in config.json is missing or too short')
  }
  const derived = hkdfSync('sha256', secret, Buffer.from('claude-link'), Buffer.from('claude-link/v1/aes-256-gcm'), 32)
  return Buffer.from(derived)
}

function additionalData(channel) {
  return Buffer.from(`claude-link/v1/${channel}`)
}

export function seal(key, channel, value) {
  const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(additionalData(channel))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, body, cipher.getAuthTag()])
}

// Returns the decoded value, or null when the message is not authentic.
export function open(key, channel, sealed, maxPlainBytes) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== FORMAT_VERSION) {
    return null
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES)
  const body = sealed.subarray(1 + IV_BYTES, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(additionalData(channel))
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(body), decipher.final()])
    const json = gunzipSync(plain, { maxOutputLength: maxPlainBytes })
    return JSON.parse(json.toString('utf8'))
  } catch {
    return null
  }
}

export function newNonce() {
  return randomBytes(16).toString('hex')
}

// Rejects stale messages and messages seen before, so a recorded request
// cannot be replayed later.
export class ReplayGuard {
  constructor(windowMs = 5 * 60 * 1000) {
    this.windowMs = windowMs
    this.seen = new Map()
  }

  accept(nonce, sentAt) {
    const now = Date.now()
    if (typeof nonce !== 'string' || nonce.length < 16 || typeof sentAt !== 'number') {
      return false
    }
    if (Math.abs(now - sentAt) > this.windowMs || this.seen.has(nonce)) {
      return false
    }
    this.seen.set(nonce, now)
    if (this.seen.size > 10000) {
      this.prune(now)
    }
    return true
  }

  prune(now) {
    for (const [nonce, seenAt] of this.seen) {
      if (now - seenAt > this.windowMs * 2) {
        this.seen.delete(nonce)
      }
    }
  }
}
