import { expect, test } from 'claude-code/testing'

// Draws the Link pane against canned daemon answers on each surface that
// can show it, and checks the "All" view groups chats by project.
const HOME = '/Users/test'
const DESKTOP_ID = '7d3f5a52-0000-4000-8000-000000000001'
const WEBSHOP = 'desktop/projects/webshop'
const PANE_PROPS = { title: 'Link', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

function sampleChat(index: number, title: string, project: string, projectKey: string, extra: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    ref: id,
    id,
    origin: DESKTOP_ID,
    machine: 'Desktop',
    title,
    project,
    projectKey,
    cwd: `C:\\Users\\test\\${projectKey.replace(/\//g, '\\')}`,
    branch: '',
    firstAt: 1000,
    lastAt: 1000 - index,
    prompts: index,
    isLocal: false,
    isArchived: false,
    live: '',
    isHere: false,
    ...extra,
  }
}

const CHATS = [
  sampleChat(1, 'Quarterly report draft', 'Admin', 'desktop/projects/admin', { live: 'idle' }),
  ...Array.from({ length: 7 }, (_, index) => sampleChat(index + 2, `Webshop task ${index + 1}`, 'Webshop', WEBSHOP)),
]

function daemonAnswer(pathname: string): unknown {
  if (pathname === '/api/status') {
    return {
      version: '0.1.0',
      machine: { id: 'mac', name: 'MacBook' },
      indexing: { isRunning: false, done: 0, total: 0 },
      counts: { local: 0, remote: CHATS.length },
      peers: [{ machineId: DESKTOP_ID, name: 'Desktop', isOnline: true, route: 'lan', lastSyncAt: 0, lastError: '' }],
    }
  }
  return {
    here: { key: 'desktop/projects/notes', label: 'Notes', repo: '' },
    scope: 'all',
    counts: { here: 0, all: CHATS.length },
    total: CHATS.length,
    chats: CHATS,
  }
}

test('the All view groups chats by project and expands a group', async ($, on) => {
  on('clock.now', () => ({ value: 1000 }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ localPort: 47600, localToken: 'test-token' }) }))
  on('session.root', () => ({ value: `${HOME}/Desktop/Projects/Notes` }))
  on('http.fetch', ($, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(daemonAnswer(new URL(e.url).pathname)) } }))

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'claude-link', surface, component: 'Pane', requestId: 'link', props: PANE_PROPS })
    await ui.press({ key: 'scope-all' })
    const openButtons = async () => (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('open-'))

    expect(await openButtons()).toHaveLength(6)
    expect(await ui.find({ type: 'Text', text: 'Webshop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Admin' })).toBeDefined()
    expect((await ui.find({ key: `toggle-${WEBSHOP}` }))?.props.label).toBe('Show 2 more')

    // Each row starts with the sidebar's circle: an Svg where the surface
    // draws one, a glyph on the terminal.
    if (surface === 'desktop') {
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(6)
    }

    await ui.press({ key: `toggle-${WEBSHOP}` })
    expect(await openButtons()).toHaveLength(8)
    expect((await ui.find({ key: `toggle-${WEBSHOP}` }))?.props.label).toBe('Show less')
    await ui.press({ key: `toggle-${WEBSHOP}` })

    // The filter narrows the list as the person types, without a request.
    await ui.input({ key: 'filter', text: 'task 7', kind: 'change' })
    expect(await openButtons()).toHaveLength(1)
    await ui.input({ key: 'filter', text: '', kind: 'change' })
    expect(await openButtons()).toHaveLength(6)
    await ui.unmount()
  }
})

// A session of another Claude profile (CLAUDE_CONFIG_DIR set, no
// CLAUDE_LINK_HOME of its own) is told to enroll that profile; it never falls
// back to the default instance's config or asks any daemon.
test('a session of an unenrolled profile never reaches the default instance', async ($, on) => {
  let fetches = 0
  let reads = 0
  on('clock.now', () => ({ value: 1000 }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : e.name === 'CLAUDE_CONFIG_DIR' ? `${HOME}/.claude-work` : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => {
    reads += 1
    return { value: JSON.stringify({ localPort: 47600, localToken: 'default-token' }) }
  })
  on('session.root', () => ({ value: `${HOME}/Desktop/Projects/Notes` }))
  on('http.fetch', () => {
    fetches += 1
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })

  const ui = await $.ui.mount({ plugin: 'claude-link', surface: 'terminal', component: 'Pane', requestId: 'link', props: PANE_PROPS })
  await ui.press({ key: 'scope-all' })
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.some(text => String(text.props.children ?? '').includes('no Claude Link instance of its own'))).toBe(true)
  expect(fetches).toBe(0)
  expect(reads).toBe(0)
  await ui.unmount()
})
