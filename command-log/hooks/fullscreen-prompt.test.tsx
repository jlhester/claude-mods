import { expect, test } from 'claude-code/testing'

const pane = (surface: 'terminal' | 'mobile', isFullscreen: boolean) =>
  ({
    plugin: 'command-log',
    component: 'Pane',
    requestId: 'command-log',
    surface,
    viewport: { columns: 120, rows: 40, isFullscreen },
    props: {
      title: 'Command log',
      isFocused: false,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

const QUESTION = { type: 'Text', text: /Show this log on the right/ } as const

function engine(on: any, stored: Record<string, unknown> = {}) {
  const runs: string[] = []
  const toasts: string[] = []
  const opens: string[] = []
  on('command.register', () => ({ value: { command: 'logpane' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: unknown, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('command.run', { command: 'tui' }, (_: unknown, e: any) => {
    runs.push(e.args)
    return { text: 'switching' }
  })
  on('store.delete', (_: unknown, e: any) => {
    delete stored[e.key]
    return { value: undefined }
  })
  on('ui.open', (_: unknown, e: any) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('clock.after', () => ({ value: {} }))
  // A toast here is the mod's message that the switch failed.
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { runs, stored, toasts, opens }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
// The engine stamps `presentation` on a real run; the harness does not.
const logpane = ($: any, isFullscreen: boolean) =>
  $.command.run({
    command: 'logpane',
    args: 'fullscreen',
    presentation: { isFullscreen, columns: 120 },
  })

test('asks on the main screen only', async ($, on) => {
  engine(on)
  await start($)

  const main = await $.ui.mount(pane('terminal', false))
  expect(await main.find(QUESTION)).toBeDefined()
  await main.unmount()

  const full = await $.ui.mount(pane('terminal', true))
  expect(await full.find(QUESTION)).toBeUndefined()
  await full.unmount()

  const mobile = await $.ui.mount(pane('mobile', false))
  expect(await mobile.find(QUESTION)).toBeUndefined()
  await mobile.unmount()
})

test('Switch runs /tui fullscreen and does not ask again', async ($, on) => {
  const { runs, stored } = engine(on)
  await start($)

  const ui = await $.ui.mount(pane('terminal', false))
  await ui.press({ key: 'fullscreen-switch' })
  await settle()

  expect(runs).toEqual(['fullscreen'])
  expect(stored['fullscreen-prompt-answered']).toBe(true)
  expect(await ui.find(QUESTION)).toBeUndefined()
  await ui.unmount()
})

test('the session after a switch opens the pane once', async ($, on) => {
  const { stored, opens } = engine(on, { 'reopen-after-fullscreen': true })
  await start($)
  await settle()

  expect(opens).toEqual(['command-log'])
  expect(stored['reopen-after-fullscreen']).toBeUndefined()
})

test('a session with no switch behind it opens nothing', async ($, on) => {
  const { opens } = engine(on)
  await start($)
  await settle()

  expect(opens).toEqual([])
})

test('Not now runs nothing and is remembered', async ($, on) => {
  const { runs, stored } = engine(on)
  await start($)

  const ui = await $.ui.mount(pane('terminal', false))
  await ui.press({ key: 'fullscreen-decline' })
  await settle()

  expect(runs).toEqual([])
  expect(stored['fullscreen-prompt-answered']).toBe(true)
  expect(await ui.find(QUESTION)).toBeUndefined()
  await ui.unmount()
})

test('an answer from an earlier session is not asked again', async ($, on) => {
  engine(on, { 'fullscreen-prompt-answered': true })
  await start($)

  const ui = await $.ui.mount(pane('terminal', false))
  expect(await ui.find(QUESTION)).toBeUndefined()
  await ui.unmount()
})

test('/logpane fullscreen switches from the main screen', async ($, on) => {
  const { runs, toasts } = engine(on)
  await start($)

  const { text } = await logpane($, false)
  await settle()

  expect(text).toMatch(/Switching/)
  expect(runs).toEqual(['fullscreen'])
  expect(toasts).toEqual([])
})

test('/logpane fullscreen leaves a fullscreen session alone', async ($, on) => {
  const { runs } = engine(on)
  await start($)

  const { text } = await logpane($, true)
  await settle()

  expect(text).toMatch(/Already/)
  expect(runs).toEqual([])
})
