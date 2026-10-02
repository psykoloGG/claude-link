export type LinkScope = 'here' | 'all'

export type LinkPeer = {
  machineId: string
  name: string
  isOnline: boolean
  route: string
  lastSyncAt: number
  lastError: string
}

export type LinkStatus = {
  machine: string
  peers: LinkPeer[]
  indexing: string
}

export type LinkChat = {
  ref: string
  origin: string
  machine: string
  title: string
  project: string
  projectKey: string
  projectParent: string
  lastAt: number
  prompts: number
  live: string
  isHere: boolean
}

export type LinkTool = {
  name: string
  input: string
  isError: boolean
}

export type LinkTurn = {
  role: 'user' | 'assistant' | 'note'
  at: number
  text: string
  tools: LinkTool[]
}

export type LinkDetail = {
  chat: LinkChat
  turns: LinkTurn[]
  totalTurns: number
  omittedTurns: number
}

export type LinkCounts = {
  here: number
  all: number
}

declare module 'claude-code' {
  interface PluginState {
    'claude-link': {
      status: LinkStatus | null
      chats: LinkChat[]
      counts: LinkCounts
      project: string
      expanded: string[]
      lastOpened: string
      scope: LinkScope
      query: string
      detail: LinkDetail | null
      busy: string
      error: string
    }
  }
}
