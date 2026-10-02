import dgram from 'node:dgram'
import os from 'node:os'

import { ID_PATTERN } from './config.mjs'
import { debug } from './log.mjs'
import { Channel, ReplayGuard, newNonce, open, seal } from './seal.mjs'

const ANNOUNCE_INTERVAL_MS = 30 * 1000
const BEACON_MAX_AGE_MS = 2 * 60 * 1000
const REPLY_COOLDOWN_MS = 10 * 1000

function broadcastAddresses() {
  const addresses = new Set(['255.255.255.255'])
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.netmask) {
        continue
      }
      const address = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      addresses.add(address.map((part, index) => part | (~mask[index] & 255)).join('.'))
    }
  }
  return [...addresses]
}

// Finds linked machines on the same network. Beacons are sealed with the link
// key, so only paired machines can read them or be found by them; they carry
// no chat data, just "this machine id listens on this port".
export function startDiscovery({ config, key, onBeacon }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const guard = new ReplayGuard(BEACON_MAX_AGE_MS)
  const lastReplies = new Map()
  let timer = null

  const send = (address, isAnnouncement) => {
    const beacon = { machineId: config.machineId, name: config.machineName, peerPort: config.peerPort, ts: Date.now(), nonce: newNonce(), isAnnouncement }
    socket.send(seal(key, Channel.Beacon, beacon), config.discoveryPort, address, error => {
      if (error) {
        debug.log(`Beacon to ${address} failed:`, error)
      }
    })
  }
  const announce = () => {
    for (const address of broadcastAddresses()) {
      send(address, true)
    }
  }

  socket.on('error', error => debug.warn('LAN discovery stopped:', error))
  socket.on('message', (message, remote) => {
    const beacon = open(key, Channel.Beacon, message, 64 * 1024)
    if (!beacon || beacon.machineId === config.machineId || !ID_PATTERN.test(beacon.machineId ?? '')) {
      return
    }
    const port = Number(beacon.peerPort)
    if (!guard.accept(beacon.nonce, beacon.ts) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return
    }
    onBeacon({ machineId: beacon.machineId, name: String(beacon.name ?? '').slice(0, 80), url: `http://${remote.address}:${port}` })
    // Answer an announcement directly, so a machine that just woke up
    // finds us without waiting for our next broadcast.
    const lastReply = lastReplies.get(remote.address) ?? 0
    if (beacon.isAnnouncement && Date.now() - lastReply > REPLY_COOLDOWN_MS) {
      lastReplies.set(remote.address, Date.now())
      send(remote.address, false)
    }
  })
  socket.bind(config.discoveryPort, () => {
    socket.setBroadcast(true)
    announce()
    timer = setInterval(announce, ANNOUNCE_INTERVAL_MS)
  })

  return {
    announce,
    close() {
      clearInterval(timer)
      socket.close()
    },
  }
}
