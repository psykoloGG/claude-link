import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Runs two real daemons with their own homes and checks that chats travel
// both ways, that appended messages arrive incrementally, and that requests
// without the link key are refused.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-link.mjs')
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function run(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CLAUDE_LINK_HOME: home } })
    let output = ''
    child.stdout.on('data', data => {
      output += data
    })
    child.stderr.on('data', data => {
      output += data
    })
    child.on('exit', code => (code === 0 ? resolve(output) : reject(new Error(`${args[0]} failed: ${output}`))))
  })
}

function transcriptLine(uuid, parent, role, text, cwd) {
  const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] }
  return `${JSON.stringify({ type: role, uuid, parentUuid: parent, timestamp: new Date().toISOString(), cwd, message })}\n`
}

async function api(home, pathname, method = 'GET') {
  const config = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${config.localPort}${pathname}`, { method, headers: { authorization: `Bearer ${config.localToken}` } })
  return response.json()
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) {
      return value
    }
    await sleep(300)
  }
  throw new Error('Timed out waiting for the condition')
}

test('two daemons sync chats both ways and append incrementally', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-link-test-'))
  const homes = { laptop: path.join(root, 'laptop'), desktop: path.join(root, 'desktop') }
  const claudeDirs = { laptop: path.join(root, 'laptop-claude'), desktop: path.join(root, 'desktop-claude') }
  const ports = { laptop: 47710, desktop: 47720 }

  await run(homes.desktop, ['init', '--name', 'Desktop'])
  const code = (await run(homes.desktop, ['pair-code'])).trim().split('\n').pop()
  await run(homes.laptop, ['join', code, '--name', 'Laptop'])

  const desktopConfig = JSON.parse(await fs.readFile(path.join(homes.desktop, 'config.json'), 'utf8'))
  const laptopConfig = JSON.parse(await fs.readFile(path.join(homes.laptop, 'config.json'), 'utf8'))
  Object.assign(desktopConfig, { localPort: ports.desktop, peerPort: ports.desktop + 1, discovery: false, claudeDir: claudeDirs.desktop, homeDir: 'C:\\Users\\alex', peers: [] })
  // A long interval, so only a change-triggered sync can deliver in time below.
  Object.assign(laptopConfig, { localPort: ports.laptop, peerPort: ports.laptop + 1, discovery: false, claudeDir: claudeDirs.laptop, homeDir: '/Users/alex', syncIntervalSeconds: 300 })
  laptopConfig.peers = [{ name: 'Desktop', machineId: desktopConfig.machineId, urls: [`http://127.0.0.1:${ports.desktop + 1}`] }]
  await fs.writeFile(path.join(homes.desktop, 'config.json'), JSON.stringify(desktopConfig))
  await fs.writeFile(path.join(homes.laptop, 'config.json'), JSON.stringify(laptopConfig))

  const desktopChat = path.join(claudeDirs.desktop, 'projects', 'C--Users-alex-Desktop-Shop')
  const laptopChat = path.join(claudeDirs.laptop, 'projects', '-Users-alex-Desktop-Shop')
  await fs.mkdir(desktopChat, { recursive: true })
  await fs.mkdir(laptopChat, { recursive: true })
  const desktopFile = path.join(desktopChat, '11111111-1111-4111-8111-111111111111.jsonl')
  await fs.writeFile(desktopFile, transcriptLine('d1', null, 'user', 'Set up checkout on the desktop', 'C:\\Users\\alex\\Desktop\\Shop'))
  await fs.writeFile(path.join(laptopChat, '22222222-2222-4222-8222-222222222222.jsonl'), transcriptLine('l1', null, 'user', 'Draft the pricing page on the laptop', '/Users/alex/Desktop/Shop'))

  // The laptop has a build of the daemon and mod; the desktop has none yet.
  await run(homes.laptop, ['publish', '--from', PROJECT_ROOT])

  const daemons = Object.values(homes).map(home => spawn(process.execPath, [CLI, 'serve'], { env: { ...process.env, CLAUDE_LINK_HOME: home }, stdio: 'ignore' }))
  t.after(async () => {
    for (const daemon of daemons) {
      daemon.kill()
    }
    await sleep(300)
    await fs.rm(root, { recursive: true, force: true })
  })

  const laptopSees = await waitFor(async () => {
    const list = await api(homes.laptop, '/api/chats?scope=here&cwd=%2FUsers%2Falex%2FDesktop%2FShop').catch(() => null)
    return list?.chats?.length === 1 ? list : null
  })
  assert.equal(laptopSees.chats[0].machine, 'Desktop')
  assert.equal(laptopSees.chats[0].title, 'Set up checkout on the desktop')

  const desktopSees = await waitFor(async () => {
    const list = await api(homes.desktop, '/api/chats?scope=all').catch(() => null)
    return list?.chats?.length === 1 ? list : null
  })
  assert.equal(desktopSees.chats[0].machine, 'Laptop')

  // A new reply on the desktop reaches the laptop as an appended tail.
  await fs.appendFile(desktopFile, transcriptLine('d2', 'd1', 'assistant', 'Checkout now uses the hosted page.', 'C:\\Users\\alex\\Desktop\\Shop'))
  await waitFor(async () => {
    await api(homes.laptop, '/api/sync', 'POST')
    const chat = await api(homes.laptop, '/api/chat?ref=11111111-1111-4111-8111-111111111111')
    return chat.turns?.length === 2 ? chat : null
  }, 30000)

  const search = await api(homes.laptop, '/api/search?q=hosted%20page')
  assert.equal(search.hits.length, 1)

  // A new message on the laptop reaches the desktop within seconds on its
  // own, long before the five-minute interval.
  await fs.appendFile(
    path.join(laptopChat, '22222222-2222-4222-8222-222222222222.jsonl'),
    transcriptLine('l2', 'l1', 'assistant', 'The pricing page has three tiers.', '/Users/alex/Desktop/Shop'),
  )
  await waitFor(async () => {
    const chat = await api(homes.desktop, '/api/chat?ref=22222222-2222-4222-8222-222222222222')
    return chat.turns?.length === 2 ? chat : null
  }, 12000)

  // The desktop ended up on the laptop's build, mod included.
  const readBuild = async home => JSON.parse(await fs.readFile(path.join(home, 'bundle.json'), 'utf8'))
  const laptopBuild = await readBuild(homes.laptop)
  const desktopBuild = await waitFor(async () => {
    const build = await readBuild(homes.desktop).catch(() => null)
    return build?.hash === laptopBuild.hash ? build : null
  })
  assert.equal(desktopBuild.publishedAt, laptopBuild.publishedAt)
  const desktopMod = await fs.readFile(path.join(homes.desktop, 'mod', 'hooks', 'register.tsx'), 'utf8')
  assert.equal(desktopMod, await fs.readFile(path.join(PROJECT_ROOT, 'mod', 'hooks', 'register.tsx'), 'utf8'))

  // The peer port answers nothing useful without the link key.
  const refused = await fetch(`http://127.0.0.1:${ports.desktop + 1}/link`, { method: 'POST', body: 'not sealed' })
  assert.equal(refused.status, 401)
  const noToken = await fetch(`http://127.0.0.1:${ports.desktop}/api/status`)
  assert.equal(noToken.status, 401)
})
