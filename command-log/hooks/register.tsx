import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { LogEntry, LogStatus } from '../types'

const PANE = 'command-log'
const TITLE = 'Command log'
const MAX_ENTRIES = 30
const MAX_OUTPUT = 20000
const MAX_FOLLOWED = 5

const entries = atom({ plugin: 'command-log', key: 'entries' } as const, [])

const MARK: Record<LogStatus, { mark: string; color?: string }> = {
  running: { mark: '…', color: 'warning' },
  done: { mark: '✓', color: 'success' },
  failed: { mark: '✗', color: 'error' },
  background: { mark: '⟳', color: 'suggestion' },
  stopped: { mark: '■' },
}

// How a background task's notification says it ended, as an entry's status.
const ENDED: Record<string, LogStatus> = { completed: 'done', failed: 'failed', killed: 'stopped' }

// Background tails this module started, by entry id; each one's stop ends its
// stream, which kills its tail.
const followed = new Map<string, () => Promise<unknown>>()
// Each background entry's output file, by entry id.
const outputPaths = new Map<string, string>()
let isClosedByPerson = false
let isKeepingHistory = false

// Strips colour codes and keeps only what a carriage return left on each line.
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .split('\n')
    .map(line => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
}

// Splits a line into rows of at most `width` cells, continuing under `indent`.
function wrap(text: string, width: number, indent: string): string[] {
  const rows = [text.slice(0, width)]
  const room = Math.max(1, width - indent.length)
  for (let at = width; at < text.length; at += room) rows.push(indent + text.slice(at, at + room))
  return rows
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text
}

// A background entry counts only while this module follows it: one left over
// from before a reload has nothing left to finish it.
function isLive(one: LogEntry): boolean {
  return one.status === 'running' || (one.status === 'background' && followed.has(one.id))
}

function patch($: EngineInterface, id: string, fn: (one: LogEntry) => LogEntry) {
  return update($, entries, list => list.map(one => (one.id === id ? fn(one) : one)))
}

async function stopFollowing($: EngineInterface, id: string) {
  const stop = followed.get(id)
  followed.delete(id)
  outputPaths.delete(id)
  await stop?.()
  await patch($, id, one => (one.status === 'background' ? { ...one, status: 'stopped' } : one))
}

async function follow($: EngineInterface, id: string, path: string) {
  if (followed.size >= MAX_FOLLOWED) {
    const oldest = followed.keys().next().value
    if (oldest !== undefined) await stopFollowing($, oldest)
  }
  const tail = $.process.spawn({ argv: ['tail', '-n', '+1', '-F', path] })
  const stop = () => tail.return({ code: null, signal: 'SIGTERM' })
  followed.set(id, stop)
  outputPaths.set(id, path)
  try {
    for await (const { text } of tail) {
      await patch($, id, one => ({ ...one, output: cap(one.output + clean(text)) }))
    }
  } catch {
    // tail could not start or was killed; the entry keeps what it had.
  }
  if (followed.get(id) === stop) followed.delete(id)
  await patch($, id, one => (one.status === 'background' ? { ...one, status: 'stopped' } : one))
}

// A background task ended: take its output whole from its file (the tail may
// not have read the last of it yet), mark how it ended, and stop the tail.
async function finish($: EngineInterface, id: string, status: LogStatus) {
  const path = outputPaths.get(id)
  let output: string | undefined
  if (path) {
    try {
      output = String(await $.fs.read(path))
    } catch {}
  }
  const stop = followed.get(id)
  followed.delete(id)
  outputPaths.delete(id)
  await stop?.()
  await patch($, id, one => ({
    ...one,
    status,
    output: output === undefined ? one.output : cap(clean(output)),
  }))
}

// Without keep_history a new command clears the finished entries and keeps
// the ones still running.
async function record($: EngineInterface, id: string, command: string, description?: string) {
  const entry: LogEntry = { id, command, description, status: 'running', output: '' }
  if (isKeepingHistory) {
    await update($, entries, list => [...list, entry].slice(-MAX_ENTRIES))
  } else {
    await update($, entries, list => [...list.filter(isLive), entry])
  }
  if (!isClosedByPerson) void $.ui.open({ id: PANE, title: TITLE })
}

async function settle($: EngineInterface, id: string, ran: ToolCallResult<'Bash'>) {
  if (ran.deny !== undefined) {
    await patch($, id, one => ({ ...one, status: 'failed', output: ran.deny }))
    return
  }
  if (ran.isError) {
    await patch($, id, one => ({ ...one, status: 'failed', output: cap(clean(ran.text ?? '')) }))
    return
  }

  const result = ran.result
  // The path ends a sentence in the result text: drop the full stop after it.
  const outputPath = /Output is being written to:?\s*(\S+)/
    .exec(ran.text ?? '')?.[1]
    ?.replace(/[.,;:]+$/, '')
  if (result.backgroundTaskId && outputPath) {
    await patch($, id, one => ({ ...one, status: 'background' }))
    void follow($, id, outputPath)
    return
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  await patch($, id, one => ({
    ...one,
    status: result.interrupted ? 'stopped' : 'done',
    output: cap(clean(output || (result.backgroundTaskId ? (ran.text ?? '') : ''))),
  }))
}

async function clear($: EngineInterface) {
  for (const id of [...followed.keys()]) await stopFollowing($, id)
  await update($, entries, () => [])
}

export const register: Register = (on, options) => {
  followed.clear()
  outputPaths.clear()
  isClosedByPerson = false
  isKeepingHistory = options.keep_history === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'logpane',
      description: 'Show the command log pane (`/logpane clear` empties it)',
    })

    return next(e)
  })

  on('command.run', { command: 'logpane' }, async ($, e) => {
    if (/\bclear\b/.test(e.args)) {
      await clear($)
      return { text: 'Command log cleared.' }
    }
    isClosedByPerson = false
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Command log pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') isClosedByPerson = true

    return next(e)
  })

  // The command itself always runs and returns as it would without this mod:
  // a failure in the log's own bookkeeping only leaves the pane behind.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id ?? `bash-${Date.now()}`
    try {
      await record($, id, e.command, e.description)
    } catch {}

    const ran = await next(e)
    try {
      await settle($, id, ran)
    } catch {}

    return ran
  })

  // A background command's end reaches the session as a task notification
  // naming the call that started it.
  on('session.append', async ($, e, next) => {
    const appended = await next(e)
    try {
      const text = JSON.stringify(e.message.content ?? '')
      const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1]
      const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]
      if (id && status && outputPaths.has(id)) await finish($, id, ENDED[status] ?? 'done')
    } catch {}

    return appended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, entries)
    const width = Math.max(10, e.props.bodyColumns)
    const room = Math.max(1, e.props.scroll.bodyRows)

    const rows: { text: string; color?: string; dim?: boolean; bold?: boolean }[] = []
    for (const one of list) {
      const { mark, color } = MARK[one.status]
      // The whole command, every line of it wrapped to the pane's width.
      one.command.split('\n').forEach((line, i) => {
        for (const text of wrap(i === 0 ? `${mark} $ ${line}` : `    ${line}`, width, '    ')) {
          rows.push({ text, color, bold: true })
        }
      })
      if (one.description) rows.push({ text: `  ${one.description}`, dim: true })
      if (one.output) {
        for (const line of one.output.replace(/\n+$/, '').split('\n')) rows.push({ text: `  ${line}` })
      }
    }

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No commands yet.</Text>}
        {rows.slice(-room).map(row => (
          <Text wrap="truncate-end" color={row.color} dimColor={row.dim} bold={row.bold}>
            {row.text || ' '}
          </Text>
        ))}
      </Box>
    )
  })
}
