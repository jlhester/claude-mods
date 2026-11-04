import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { LogEntry, LogStatus } from '../types'

const PANE = 'command-log'
const TITLE = 'Command log'
const MAX_ENTRIES = 30
const MAX_OUTPUT = 20000
const MAX_FOLLOWED = 5
// A pane draws the first 100,000 characters of its texts: keep the newest
// rows within this, so the oldest drop off the top rather than mid-row.
const MAX_DRAWN = 90000
const USAGE = 'Usage: /logpane [close | clear | fullscreen | history [on|off]]'

// The fullscreen question is asked once per install: the answer is kept in the
// store across sessions, and in this atom so that answering redraws the pane.
const ANSWERED_KEY = 'fullscreen-prompt-answered'
// Set just before /tui relaunches: the new process opens the pane again, as
// nothing else would until Claude's next command.
const REOPEN_KEY = 'reopen-after-fullscreen'
// Kept in the store so a closed pane stays closed through reloads and sessions.
const CLOSED_KEY = 'closed-by-person'
// A pane opened unasked waits undrawn on a narrow terminal: say so, once.
const WAITING_HINT_KEY = 'waiting-hint-shown'
const WAITING_HINT = 'The command log is waiting for a wider terminal. Run /logpane to show it now.'
const NOT_DOCKED = 'Now in fullscreen. Run /logpane to show the command log.'
const FULLSCREEN_MANUALLY = 'Could not switch to fullscreen: type /tui fullscreen instead.'

const entries = atom({ plugin: 'command-log', key: 'entries' } as const, [])
const isPromptAnswered = atom({ plugin: 'command-log', key: 'isPromptAnswered' } as const, false)

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
let isWaitingHintDue = false

// Strips colour codes and keeps only what a carriage return left on each line.
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .split('\n')
    .map(line => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
}

// What a text row may hold: the engine refuses a whole drawing over one control
// character. Run at drawing so a sequence split across two reads is caught whole.
function printable(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]?/g, '')
    .replace(/\x1b[ -\/]*[0-~]?/g, '')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
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
  if (!isClosedByPerson) void openUnasked($)
}

async function openUnasked($: EngineInterface) {
  const isPlaced = await open($)
  if (isPlaced || !isWaitingHintDue) return
  isWaitingHintDue = false
  await $.store.set(WAITING_HINT_KEY, true)
  $.ui.toast(WAITING_HINT)
}

async function setClosed($: EngineInterface, isClosed: boolean) {
  isClosedByPerson = isClosed
  await $.store.set(CLOSED_KEY, isClosed)
}

// Opens the pane (or keeps it open), brings its newest rows into view, and says
// whether it is drawn.
async function open($: EngineInterface): Promise<boolean> {
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
  try {
    await $.ui.scroll({ in: PANE, to: 'end' })
  } catch {}

  return isPlaced
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

async function answerPrompt($: EngineInterface) {
  await update($, isPromptAnswered, () => true)
  await $.store.set(ANSWERED_KEY, true)
}

// /tui saves the setting for every session and relaunches this one. It runs from
// a timer, after the calling hook has returned: the engine refuses a run from a
// command.run hook, which would wait on the turn that hook is holding.
async function switchToFullscreen($: EngineInterface) {
  await $.store.set(REOPEN_KEY, true)
  $.clock.after(1, () => {
    void $.command.run({ command: 'tui', args: 'fullscreen' }).catch(async () => {
      await $.store.delete(REOPEN_KEY)
      $.ui.toast(FULLSCREEN_MANUALLY)
    })
  })
}

async function reopenAfterSwitch($: EngineInterface) {
  if ((await $.store.get(REOPEN_KEY)) !== true) return
  await $.store.delete(REOPEN_KEY)
  await setClosed($, false)
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced) $.ui.toast(NOT_DOCKED)
}

export const register: Register = (on, options) => {
  followed.clear()
  outputPaths.clear()
  isClosedByPerson = false
  isKeepingHistory = options.keep_history === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'logpane',
      description: 'Show the pane of Bash commands Claude runs',
      argumentHint: '[close | clear | fullscreen | history [on|off]]',
    })
    if ((await $.store.get(ANSWERED_KEY)) === true) await update($, isPromptAnswered, () => true)
    isClosedByPerson = (await $.store.get(CLOSED_KEY)) === true
    isWaitingHintDue = (await $.store.get(WAITING_HINT_KEY)) !== true
    void reopenAfterSwitch($)

    return next(e)
  })

  on('command.run', { command: 'logpane' }, async ($, e) => {
    const [action = '', value, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (rest.length > 0 || (value !== undefined && action !== 'history')) return { text: USAGE }

    switch (action) {
      case '':
        await setClosed($, false)
        await open($)

        return { text: 'Command log pane opened.' }
      case 'clear':
        await clear($)

        return { text: 'Command log cleared.' }
      case 'close':
        // Closed by command, it stays closed as if the person had closed it.
        await setClosed($, true)
        await $.ui.close({ id: PANE })

        return { text: 'Command log pane closed. `/logpane` opens it again.' }
      case 'fullscreen':
        if (e.presentation.isFullscreen) {
          return { text: 'Already in fullscreen. The pane docks on the right at 110 columns or wider.' }
        }
        await answerPrompt($)
        await switchToFullscreen($)

        return { text: 'Switching to fullscreen. This session restarts.' }
      case 'history': {
        if (value !== undefined && value !== 'on' && value !== 'off') return { text: USAGE }
        // Keep history is a /config row: setting it there reloads the mod with it.
        const isOn = value === undefined ? !isKeepingHistory : value === 'on'
        const row = (await $.config.list()).find(
          one => one.key.startsWith('command-log') && one.key.endsWith('.keep_history'),
        )
        if (!row) return { text: 'Keep history setting not found; change it in /config.' }
        const set = await $.config.set({ key: row.key, value: isOn })
        if ('deny' in set && set.deny) return { text: `Keep history not changed: ${set.deny}` }

        return { text: `Keep history ${isOn ? 'on' : 'off'}.` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await setClosed($, true)

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
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, entries)
    // Only the terminal's main screen can gain a dock from /tui: fullscreen at
    // under 110 columns is inline too, but switching would not change that.
    const isOffering =
      e.surface === 'terminal' &&
      e.viewport?.isFullscreen === false &&
      !(await read($, isPromptAnswered))
    const width = Math.max(10, e.props.bodyColumns)

    const rows: { text: string; color?: string; dim?: boolean; bold?: boolean }[] = []
    for (const one of list) {
      const { mark, color } = MARK[one.status]
      // The whole command, every line of it wrapped to the pane's width.
      one.command.split('\n').forEach((line, i) => {
        const shown = printable(line)
        for (const text of wrap(i === 0 ? `${mark} $ ${shown}` : `    ${shown}`, width, '    ')) {
          rows.push({ text, color, bold: true })
        }
      })
      if (one.description) {
        for (const text of wrap(`  ${printable(one.description)}`, width, '  ')) rows.push({ text, dim: true })
      }
      if (one.output) {
        for (const line of one.output.replace(/\n+$/, '').split('\n')) {
          for (const text of wrap(`  ${printable(line)}`, width, '  ')) rows.push({ text })
        }
      }
    }

    // Every row is drawn and the pane scrolls over them, newest within budget.
    let first = rows.length
    for (let used = 0; first > 0 && used + rows[first - 1]!.text.length <= MAX_DRAWN; first--) {
      used += rows[first - 1]!.text.length
    }

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No commands yet.</Text>}
        {rows.slice(first).map(row => (
          <Text wrap="truncate-end" color={row.color} dimColor={row.dim} bold={row.bold}>
            {row.text || ' '}
          </Text>
        ))}
        {isOffering && (
          // Last, as the pane follows its end. The main screen reports no mouse
          // clicks, so the words give the keys.
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Show this log on the right?</Text>
            <Text>That turns on fullscreen for all sessions and restarts this one.</Text>
            <Text dimColor>Press ctrl+x tab, then s or n. /logpane fullscreen also does this.</Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="fullscreen-switch"
                hotkey="s"
                variant="primary"
                onPress={async () => {
                  await answerPrompt($)
                  await switchToFullscreen($)
                }}
              >
                Switch
              </Button>
              <Button key="fullscreen-decline" hotkey="n" onPress={() => answerPrompt($)}>
                Not now
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
