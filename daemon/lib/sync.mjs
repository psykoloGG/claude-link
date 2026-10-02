import { spawn } from 'node:child_process'
import net from 'node:net'

import { bundleHash, formatBuild, installBundle, installedFiles, isNewer, readBundleInfo, validateFiles } from './bundle.mjs'
import { ID_PATTERN, Ports, saveConfig } from './config.mjs'
import { debug } from './log.mjs'
import { PeerOp, callPeer } from './peer.mjs'
import { chatKey, isValidChat } from './store.mjs'

export const RouteKind = Object.freeze({
  Lan: 'lan',
  Url: 'url',
  Ssh: 'ssh',
  Inbound: 'inbound',
})

// How long a machine that connected to us counts as online.
const INBOUND_FRESH_MS = 3 * 60 * 1000

const HELLO_TIMEOUT_MS = 3000
const SSH_HELLO_TIMEOUT_MS = 20000
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000
const SSH_OPEN_TIMEOUT_MS = 25000
const SSH_IDLE_MS = 10 * 60 * 1000
const DISCOVERED_TTL_MS = 3 * 60 * 1000
const CHUNK_BYTES = 8 * 1024 * 1024
const TRIGGER_DELAY_MS = 2000
const MAX_CHUNKS_PER_FILE = 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readBuild(value) {
  return { publishedAt: Number(value?.publishedAt) || 0, hash: typeof value?.hash === 'string' ? value.hash.slice(0, 64) : '' }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = isOpen => {
      socket.destroy()
      resolve(isOpen)
    }
    socket.setTimeout(800, () => finish(false))
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

// Reaches a machine through an SSH port forward, for when it is not on the
// same network: the existing SSH setup (keys, Cloudflare Access) does the
// authentication and nothing new is exposed to the internet.
class SshForward {
  constructor(host, remotePort) {
    this.host = host
    this.remotePort = remotePort
    this.child = null
    this.port = 0
    this.url = ''
    this.lastUsedAt = 0
  }

  async open() {
    this.lastUsedAt = Date.now()
    if (this.child && this.child.exitCode === null && this.url && (await canConnect(this.port))) {
      return this.url
    }
    this.close()
    this.port = await freePort()
    const args = ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
      '-L', `127.0.0.1:${this.port}:127.0.0.1:${this.remotePort}`, this.host]
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    let stderr = ''
    child.stderr.on('data', data => {
      stderr = `${stderr}${data}`.slice(-2000)
    })
    child.on('error', error => {
      stderr = `${stderr}\n${error.message}`
    })
    const deadline = Date.now() + SSH_OPEN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const lastLine = stderr.trim().split('\n').pop()
        this.close()
        throw new Error(`ssh ${this.host} exited (${lastLine || child.exitCode})`)
      }
      if (await canConnect(this.port)) {
        this.url = `http://127.0.0.1:${this.port}`
        return this.url
      }
      await sleep(300)
    }
    this.close()
    throw new Error(`ssh ${this.host} did not open a tunnel in time`)
  }

  close() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill()
    }
    this.child = null
    this.url = ''
  }
}

// Keeps chats in step with every linked machine it can reach: pulls what the
// other side has that is newer, then offers ours. Since a laptop can usually
// reach an always-on desktop but not the other way round, the side that
// connects does both directions.
export class SyncEngine {
  constructor({ config, key, store }) {
    this.config = config
    this.key = key
    this.store = store
    this.discovered = new Map()
    this.inbound = new Map()
    this.inboundBuilds = new Map()
    this.statuses = new Map()
    this.running = new Map()
    this.resyncWanted = new Set()
    this.forwards = new Map()
    this.intervalTimer = null
    this.idleTimer = null
    this.triggerTimer = null
  }

  start() {
    const intervalMs = Math.max(15, Number(this.config.syncIntervalSeconds) || 60) * 1000
    this.intervalTimer = setInterval(() => this.syncAll('interval'), intervalMs)
    this.idleTimer = setInterval(() => this.closeIdleForwards(), 60 * 1000)
  }

  stop() {
    clearInterval(this.intervalTimer)
    clearInterval(this.idleTimer)
    clearTimeout(this.triggerTimer)
    this.triggerTimer = null
    for (const forward of this.forwards.values()) {
      forward.close()
    }
  }

  trigger(reason) {
    if (this.triggerTimer) {
      return
    }
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null
      this.syncAll(reason)
    }, TRIGGER_DELAY_MS)
  }

  noteBeacon({ machineId, name, url }) {
    const previous = this.discovered.get(machineId)
    this.discovered.set(machineId, { url, name, seenAt: Date.now() })
    const status = [...this.statuses.values()].find(entry => entry.machineId === machineId)
    if (!previous || previous.url !== url || !status?.isOnline) {
      this.trigger('discovered')
    }
  }

  // Configured machines, plus machines that answered on the LAN without being
  // configured (they hold the link key, so they are paired).
  peers() {
    const list = (this.config.peers ?? []).map((peer, index) => ({
      key: peer.machineId || `configured-${index}`,
      machineId: peer.machineId ?? '',
      name: peer.name || 'Linked machine',
      config: peer,
    }))
    for (const [machineId, found] of this.discovered) {
      if (!list.some(peer => peer.machineId === machineId)) {
        list.push({ key: machineId, machineId, name: found.name || 'Linked machine', config: null })
      }
    }
    return list
  }

  routesFor(peer) {
    const routes = []
    const found = peer.machineId ? this.discovered.get(peer.machineId) : null
    if (found && Date.now() - found.seenAt < DISCOVERED_TTL_MS) {
      routes.push({ kind: RouteKind.Lan, url: found.url })
    }
    for (const url of peer.config?.urls ?? []) {
      if (!routes.some(route => route.url === url)) {
        routes.push({ kind: RouteKind.Url, url, headers: peer.config.headers })
      }
    }
    if (peer.config?.ssh) {
      routes.push({ kind: RouteKind.Ssh, host: peer.config.ssh, remotePort: peer.config.sshPort || Ports.Peer })
    }
    return routes
  }

  statusFor(peer) {
    let status = this.statuses.get(peer.key)
    if (!status) {
      status = { machineId: peer.machineId, name: peer.name, isOnline: false, route: '', lastSyncAt: 0, lastAttemptAt: 0, lastError: '', pulled: 0, pushed: 0, build: null }
      this.statuses.set(peer.key, status)
    }
    return status
  }

  // A machine we cannot reach may still be reaching us (a laptop away from
  // home syncing over SSH), so recent inbound contact also counts as online.
  peerStatus() {
    const now = Date.now()
    const list = this.peers().map(peer => {
      const status = { ...this.statusFor(peer) }
      const inboundAt = this.inbound.get(status.machineId) ?? 0
      if (!status.isOnline && now - inboundAt < INBOUND_FRESH_MS) {
        const build = this.inboundBuilds.get(status.machineId) ?? status.build
        return { ...status, isOnline: true, route: RouteKind.Inbound, lastSyncAt: Math.max(status.lastSyncAt, inboundAt), lastError: '', build }
      }
      return status
    })
    for (const [machineId, at] of this.inbound) {
      if (!list.some(entry => entry.machineId === machineId)) {
        list.push({
          machineId,
          name: this.store.machineName(machineId),
          isOnline: now - at < INBOUND_FRESH_MS,
          route: RouteKind.Inbound,
          lastSyncAt: at,
          lastAttemptAt: at,
          lastError: '',
          pulled: 0,
          pushed: 0,
          build: this.inboundBuilds.get(machineId) ?? null,
        })
      }
    }
    return list
  }

  async syncAll(reason) {
    await Promise.all(this.peers().map(peer => this.syncPeer(peer, reason)))
  }

  // One sync per machine at a time; a request that arrives during a sync
  // gets one more pass afterwards, so a change made meanwhile is not left
  // waiting for the next interval.
  syncPeer(peer, reason) {
    const existing = this.running.get(peer.key)
    if (existing) {
      this.resyncWanted.add(peer.key)
      return existing
    }
    const run = (async () => {
      do {
        this.resyncWanted.delete(peer.key)
        await this.syncPeerOnce(peer, reason)
      } while (this.resyncWanted.has(peer.key))
    })().finally(() => this.running.delete(peer.key))
    this.running.set(peer.key, run)
    return run
  }

  async syncPeerOnce(peer, reason) {
    const status = this.statusFor(peer)
    status.lastAttemptAt = Date.now()
    try {
      const connection = await this.connect(peer, status)
      await this.syncBuild(connection, status)
      status.pulled = await this.pull(connection)
      status.pushed = await this.push(connection)
      status.isOnline = true
      status.lastSyncAt = Date.now()
      status.lastError = ''
      debug.log(`Synced with ${status.name} over ${status.route} (${reason}): pulled ${status.pulled}, pushed ${status.pushed}`)
    } catch (error) {
      status.isOnline = false
      status.lastError = error.message
      debug.log(`Sync with ${status.name} failed (${reason}):`, error)
    }
  }

  async connect(peer, status) {
    const routes = this.routesFor(peer)
    if (routes.length === 0) {
      throw new Error('no address known yet (waiting for it to appear on the LAN)')
    }
    const errors = []
    for (const route of routes) {
      try {
        const url = route.kind === RouteKind.Ssh ? await this.forwardFor(route).open() : route.url
        const connection = { url, headers: route.headers, route }
        const timeoutMs = route.kind === RouteKind.Ssh ? SSH_HELLO_TIMEOUT_MS : HELLO_TIMEOUT_MS
        const hello = await this.call(connection, PeerOp.Hello, { machine: this.store.selfInfo(), live: await this.store.liveSessions(), build: await readBundleInfo() }, timeoutMs)
        const remote = hello?.machine
        if (!ID_PATTERN.test(remote?.machineId ?? '') || remote.machineId === this.config.machineId) {
          throw new Error('answered as an unexpected machine')
        }
        connection.remote = remote
        connection.build = readBuild(hello.build)
        status.build = connection.build
        this.store.recordMachine(remote)
        this.store.recordLive(remote.machineId, hello.live)
        await this.rememberMachineId(peer, remote)
        status.machineId = remote.machineId
        status.name = remote.name || status.name
        status.route = route.kind
        return connection
      } catch (error) {
        errors.push(`${route.kind}: ${error.message}`)
      }
    }
    throw new Error(errors.join('; '))
  }

  async rememberMachineId(peer, remote) {
    if (!peer.config || peer.config.machineId === remote.machineId) {
      return
    }
    peer.config.machineId = remote.machineId
    await saveConfig(this.config).catch(error => debug.warn('Could not save the peer id:', error))
  }

  forwardFor(route) {
    const key = `${route.host}:${route.remotePort}`
    let forward = this.forwards.get(key)
    if (!forward) {
      forward = new SshForward(route.host, route.remotePort)
      this.forwards.set(key, forward)
    }
    return forward
  }

  closeIdleForwards() {
    for (const forward of this.forwards.values()) {
      if (forward.child && Date.now() - forward.lastUsedAt > SSH_IDLE_MS) {
        forward.close()
      }
    }
  }

  call(connection, op, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (connection.route.kind === RouteKind.Ssh) {
      this.forwardFor(connection.route).lastUsedAt = Date.now()
    }
    return callPeer({ url: connection.url, key: this.key, selfId: this.config.machineId, op, args, timeoutMs, headers: connection.headers })
  }

  // Brings both machines onto the newest published build: pulls theirs when
  // it is newer, hands over ours when it is. A failure here never stops the
  // chats from syncing.
  async syncBuild(connection, status) {
    if (this.config.autoUpdate === false) {
      return
    }
    try {
      const local = await readBundleInfo()
      if (isNewer(connection.build, local)) {
        const build = await this.call(connection, PeerOp.Bundle, {})
        validateFiles(build.files)
        const installed = await installBundle(build.files, Number(build.publishedAt) || connection.build.publishedAt)
        debug.log(`Installed build ${formatBuild(installed)} from ${status.name}`)
      } else if (isNewer(local, connection.build)) {
        status.build = await this.call(connection, PeerOp.InstallBundle, { publishedAt: local.publishedAt, files: await installedFiles() })
        debug.log(`Sent build ${formatBuild(local)} to ${status.name}`)
      }
    } catch (error) {
      debug.warn(`Could not bring ${status.name} onto the same build:`, error)
    }
  }

  async pull(connection) {
    const manifest = await this.call(connection, PeerOp.Manifest, {})
    for (const machine of manifest?.machines ?? []) {
      this.store.recordMachine(machine)
    }
    let pulled = 0
    for (const entry of manifest?.entries ?? []) {
      if (!this.store.recordPeerEntry(entry)) {
        continue
      }
      const plan = await this.store.planTransfer(entry)
      if (!plan) {
        continue
      }
      await this.pullFile(connection, entry, plan)
      pulled += 1
    }
    return pulled
  }

  async pullFile(connection, entry, plan) {
    let from = plan.from
    let prefixFp = plan.prefixFp
    for (let chunkIndex = 0; chunkIndex < MAX_CHUNKS_PER_FILE; chunkIndex += 1) {
      const chunk = await this.call(connection, PeerOp.Pull, { origin: entry.origin, dir: entry.dir, id: entry.id, from, prefixFp, maxBytes: CHUNK_BYTES })
      const state = await this.store.writeChunk(entry.origin, entry.dir, entry.id, chunk.start, String(chunk.data ?? ''), { gen: entry.gen, totalSize: chunk.size })
      if (state.size >= chunk.size || !chunk.data) {
        return
      }
      from = state.size
      prefixFp = state.fp
    }
  }

  async push(connection) {
    const offer = await this.store.manifest(connection.remote.machineId)
    const reply = await this.call(connection, PeerOp.Offer, offer)
    let pushed = 0
    for (const want of reply?.wants ?? []) {
      if (!isValidChat(want?.origin, want?.dir, want?.id) || !this.store.catalog.has(chatKey(want.origin, want.dir, want.id))) {
        continue
      }
      await this.pushFile(connection, want)
      pushed += 1
    }
    return pushed
  }

  async pushFile(connection, want) {
    const chat = this.store.catalog.get(chatKey(want.origin, want.dir, want.id))
    let from = want.from
    let prefixFp = want.prefixFp
    for (let chunkIndex = 0; chunkIndex < MAX_CHUNKS_PER_FILE; chunkIndex += 1) {
      const range = await this.store.readRange(want.origin, want.dir, want.id, from, prefixFp, CHUNK_BYTES)
      const result = await this.call(connection, PeerOp.Push, { origin: want.origin, dir: want.dir, id: want.id, gen: chat.gen, start: range.start, data: range.data, size: range.size })
      if (result.size >= range.size || !range.data) {
        return
      }
      from = result.size
      prefixFp = result.fp
    }
  }

  // What this machine answers when another machine connects to it.
  handlers() {
    const store = this.store
    const handlers = {
      [PeerOp.Hello]: async (args, { from }) => {
        store.recordMachine({ ...(args.machine ?? {}), machineId: from })
        store.recordLive(from, args.live)
        this.inboundBuilds.set(from, readBuild(args.build))
        return { machine: store.selfInfo(), live: await store.liveSessions(), build: await readBundleInfo() }
      },
      [PeerOp.Bundle]: async () => ({ ...(await readBundleInfo()), files: await installedFiles() }),
      [PeerOp.InstallBundle]: async (args, { from }) => {
        if (this.config.autoUpdate === false) {
          throw new Error('this machine does not take code updates (autoUpdate is off)')
        }
        validateFiles(args.files)
        const local = await readBundleInfo()
        const incoming = { publishedAt: Number(args.publishedAt) || 0, hash: bundleHash(args.files) }
        if (!isNewer(incoming, local)) {
          return local
        }
        const installed = await installBundle(args.files, incoming.publishedAt)
        this.inboundBuilds.set(from, installed)
        debug.log(`Installed build ${formatBuild(installed)} sent by ${store.machineName(from)}`)
        return installed
      },
      [PeerOp.Manifest]: async (args, { from }) => store.manifest(from),
      [PeerOp.Pull]: async args => store.readRange(args.origin, args.dir, args.id, args.from, args.prefixFp, args.maxBytes),
      [PeerOp.Offer]: async (args, { from }) => {
        for (const machine of args.machines ?? []) {
          store.recordMachine(machine)
        }
        const wants = []
        for (const entry of args.entries ?? []) {
          if (!store.recordPeerEntry(entry)) {
            continue
          }
          const plan = await store.planTransfer(entry)
          if (plan) {
            wants.push({ origin: entry.origin, dir: entry.dir, id: entry.id, ...plan })
          }
        }
        return { wants }
      },
      [PeerOp.Push]: async args => {
        const gen = Number.isInteger(args.gen) ? args.gen : 0
        const totalSize = Number.isInteger(args.size) ? args.size : 0
        return store.writeChunk(args.origin, args.dir, args.id, Number(args.start) || 0, String(args.data ?? ''), { gen, totalSize })
      },
    }
    const noted = {}
    for (const [op, handler] of Object.entries(handlers)) {
      noted[op] = (args, context) => {
        this.inbound.set(context.from, Date.now())
        return handler(args, context)
      }
    }
    return noted
  }
}
