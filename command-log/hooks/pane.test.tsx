import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'command-log',
  component: 'Pane',
  requestId: 'command-log',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: {
    title: 'Command log',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

function engine(on: any, stored: Record<string, unknown> = {}, isPlaced = true) {
  const toasts: string[] = []
  const opens: string[] = []
  on('command.register', () => ({ value: { command: 'logpane' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: unknown, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('ui.open', (_: unknown, e: any) => {
    opens.push(e.id)
    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: 'narrow' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { stored, toasts, opens }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

function bashPrinting(on: any, stdout: string) {
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }))
}

test('control characters are dropped, so the drawing is not refused', async ($, on) => {
  engine(on)
  bashPrinting(on, 'A\x1b]8;;https://example.com\x1b\\LINK\x1b]8;;\x1b\\B\x07C\x1b(B\td\x9b')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls\x1b[0m\x07', description: 'lists\x07' })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ {2}ALINKBC {4}d$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$ ls$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}lists$/ })).toBeDefined()
  await ui.unmount()
})

test('an escape sequence cut off at the end of the output draws nothing', async ($, on) => {
  engine(on)
  bashPrinting(on, 'done\x1b]8;;https://exam')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ {2}done$/ })).toBeDefined()
  await ui.unmount()
})

test('long output wraps to the pane', async ($, on) => {
  engine(on)
  bashPrinting(on, '0'.repeat(300))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ {2}0{78}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}0{66}$/ })).toBeDefined()
  await ui.unmount()
})

test('a pane left waiting says so once, across commands and sessions', async ($, on) => {
  const { stored, toasts } = engine(on, {}, false)
  bashPrinting(on, 'x')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'one' })
  await $.tool.call({ tool: 'Bash', command: 'two' })
  await settle()

  expect(toasts.length).toBe(1)
  expect(stored['waiting-hint-shown']).toBe(true)

  await start($)
  await $.tool.call({ tool: 'Bash', command: 'three' })
  await settle()
  expect(toasts.length).toBe(1)
})

test('a drawn pane shows no hint', async ($, on) => {
  const { toasts } = engine(on)
  bashPrinting(on, 'x')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'one' })
  await settle()

  expect(toasts).toEqual([])
})

test('a closed pane stays closed in a later session, until /logpane', async ($, on) => {
  const { stored, opens } = engine(on)
  bashPrinting(on, 'x')
  await start($)
  await $.command.run({ command: 'logpane', args: 'close' })
  expect(stored['closed-by-person']).toBe(true)

  // session.start is what a reload or a new session runs.
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'one' })
  await settle()
  expect(opens).toEqual([])

  await $.command.run({ command: 'logpane', args: '' })
  await $.tool.call({ tool: 'Bash', command: 'two' })
  await settle()
  expect(opens.length).toBe(2)
  expect(stored['closed-by-person']).toBe(false)
})

const row = (ui: any, text: RegExp) => ui.find({ type: 'Text', text })

test('each way a command ends has its mark', async ($, on) => {
  engine(on)
  const results: Record<string, unknown> = {
    good: { result: { stdout: 'fine', stderr: '', interrupted: false } },
    bad: { result: { stdout: '', stderr: 'it broke', interrupted: false }, isError: true, text: 'it broke' },
    cut: { result: { stdout: '', stderr: '', interrupted: true } },
  }
  on('tool.call', (_: unknown, e: any) => results[e.command])
  await start($)

  for (const [command, mark] of [['good', '✓'], ['bad', '✗'], ['cut', '■']] as const) {
    await $.tool.call({ tool: 'Bash', command })
    await settle()
    const ui = await $.ui.mount(PANE)
    expect(await row(ui, new RegExp(`^${mark} \\$ ${command}$`))).toBeDefined()
    await ui.unmount()
  }
})

test('the result reaches the session untouched', async ($, on) => {
  engine(on)
  bashPrinting(on, 'kept\x07')
  await start($)

  const ran: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.result.stdout).toBe('kept\x07')
})

test('a long command wraps, and each of its lines is shown', async ($, on) => {
  engine(on)
  bashPrinting(on, '')
  await start($)
  await $.tool.call({ tool: 'Bash', command: `${'a'.repeat(100)}\nsecond line` })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await row(ui, /^ {4}a{24}$/)).toBeDefined()
  expect(await row(ui, /^ {4}second line$/)).toBeDefined()
  await ui.unmount()
})

test('without history a new command replaces the finished ones', async ($, on) => {
  engine(on)
  bashPrinting(on, 'x')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'first' })
  await $.tool.call({ tool: 'Bash', command: 'second' })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await row(ui, /\$ first$/)).toBeUndefined()
  expect(await row(ui, /\$ second$/)).toBeDefined()
  await ui.unmount()
})

test('with history finished commands stay, the last 30', { options: { keep_history: true } }, async ($, on) => {
  engine(on)
  bashPrinting(on, 'x')
  await start($)
  for (let i = 1; i <= 31; i++) await $.tool.call({ tool: 'Bash', command: `cmd${i}.` })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await row(ui, /\$ cmd1\.$/)).toBeUndefined()
  expect(await row(ui, /\$ cmd2\.$/)).toBeDefined()
  expect(await row(ui, /\$ cmd31\.$/)).toBeDefined()
  await ui.unmount()
})

test('the oldest rows drop off past the drawing budget', async ($, on) => {
  engine(on)
  on('tool.call', () => ({
    result: { stdout: Array.from({ length: 20 }, (_, i) => `L${i}.${'y'.repeat(70)}`).join('\n'), stderr: '', interrupted: false },
  }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await row(ui, /^ {2}L19\./)).toBeDefined()
  await ui.unmount()
})

test('a background command streams, then takes its file whole when it ends', async ($, on) => {
  engine(on)
  const argv: string[][] = []
  let endTail = () => {}
  const tailEnds = new Promise<void>(resolve => {
    endTail = resolve
  })
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task1' },
    text: 'Output is being written to: /tmp/out.log.',
  }))
  on('process.spawn', async function* (_: unknown, e: any) {
    argv.push(e.argv)
    yield { stream: 'stdout', text: 'partial\n' }
    // A real tail runs until it is told to stop.
    await tailEnds
    return { value: { code: 0, signal: null } }
  })
  // The mod reads the file, then stops the tail: a real one dies on that.
  on('fs.read', () => {
    endTail()
    return { value: 'whole file\n' }
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'serve', tool_use_id: 'use1' })
  await settle()

  expect(argv[0]).toEqual(['tail', '-n', '+1', '-F', '/tmp/out.log'])
  const live = await $.ui.mount(PANE)
  expect(await row(live, /^⟳ \$ serve$/)).toBeDefined()
  expect(await row(live, /^ {2}partial$/)).toBeDefined()
  await live.unmount()

  await $.session.append({
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: '<task-notification><tool-use-id>use1</tool-use-id><status>failed</status></task-notification>',
        },
      ],
    },
  })
  await settle()

  const ended = await $.ui.mount(PANE)
  expect(await row(ended, /^✗ \$ serve$/)).toBeDefined()
  expect(await row(ended, /^ {2}whole file$/)).toBeDefined()
  await ended.unmount()
})

test('/logpane clear empties the pane', async ($, on) => {
  engine(on)
  bashPrinting(on, 'x')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  await $.command.run({ command: 'logpane', args: 'clear' })

  const ui = await $.ui.mount(PANE)
  expect(await row(ui, /No commands yet/)).toBeDefined()
  await ui.unmount()
})

test('/logpane history sets the /config row', async ($, on) => {
  engine(on)
  const sets: unknown[] = []
  on('config.list', () => ({ value: [{ key: 'command-log@x.keep_history' }] }))
  on('config.set', (_: unknown, e: any) => {
    sets.push(e.value)
    return { value: e.value }
  })
  await start($)

  expect((await $.command.run({ command: 'logpane', args: 'history on' })).text).toBe('Keep history on.')
  expect((await $.command.run({ command: 'logpane', args: 'history off' })).text).toBe('Keep history off.')
  expect((await $.command.run({ command: 'logpane', args: 'history' })).text).toBe('Keep history on.')
  expect(sets).toEqual([true, false, true])
})

test('anything else shows the usage and opens nothing', async ($, on) => {
  const { opens } = engine(on)
  await start($)

  for (const args of ['foo', 'close now', 'history maybe', 'history on off', 'clear all']) {
    const { text } = await $.command.run({ command: 'logpane', args })
    expect(text).toMatch(/^Usage: \/logpane/)
  }
  expect(opens).toEqual([])
})
