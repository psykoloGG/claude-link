import { createWriteStream, promises as fs } from 'node:fs'

// Logging for the link daemon. Warnings and errors always print; debug lines
// only when CLAUDE_LINK_DEBUG=1 is set.
const DEBUG_ENABLED = process.env.CLAUDE_LINK_DEBUG === '1'
const MAX_LOG_BYTES = 5 * 1024 * 1024

let logFile = null

function write(stream, level, parts) {
  const text = parts.map(part => (part instanceof Error ? part.message : String(part))).join(' ')
  ;(logFile ?? stream).write(`${new Date().toISOString()} ${level} ${text}\n`)
}

export const debug = {
  enabled: DEBUG_ENABLED,
  log: (...parts) => {
    if (DEBUG_ENABLED) {
      write(process.stdout, 'DEBUG', parts)
    }
  },
  warn: (...parts) => write(process.stderr, 'WARN', parts),
  error: (...parts) => write(process.stderr, 'ERROR', parts),
}

// Sends daemon logging to a file (for background launchers that cannot
// redirect output), keeping one previous file once it passes 5 MB.
export async function setLogFile(file) {
  const stat = await fs.stat(file).catch(() => null)
  if (stat && stat.size > MAX_LOG_BYTES) {
    await fs.rename(file, `${file}.1`).catch(() => {})
  }
  logFile = createWriteStream(file, { flags: 'a' })
}

// Plain output for CLI commands (status, pairing), not for daemon logging.
export function print(text = '') {
  process.stdout.write(`${text}\n`)
}
