import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-panel',
  component: 'Pane',
  requestId: 'session-panel',
  props: {
    title: '세션', isFocused: false, bodyColumns: 40, placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 }, view: {},
  },
} as const

const USAGE = {
  startedAt: Date.now() - 600000,
  context: {
    tokens: 42000, window: 100000, percent: 42,
    breakdown: {
      categories: [{ name: 'Messages', tokens: 30000, color: 'x', isDeferred: false, kind: 'used' }],
      totalTokens: 42000, maxTokens: 100000, rawMaxTokens: 100000, autocompactSource: 'auto',
      percentage: 42, gridRows: [], model: 'claude-opus-5-5', memoryFiles: [],
      mcpTools: [{ name: 'mcp__Figma__x', serverName: 'Figma', tokens: 1200, isLoaded: true }],
      agents: [], skills: { totalSkills: 2, includedSkills: 2, tokens: 900,
        skillFrontmatter: [{ name: 'pdf', source: 'built-in', tokens: 500 }] },
      isAutoCompactEnabled: true,
    },
  },
  rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 7 }],
  cost: { usd: 1.23 },
}

test('the pane shows context, limits, MCP and skills; a turn writes one CSV row', async ($, on) => {
  const files = new Map<string, string>()
  on('command.register', () => ({ value: { command: 'session-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: 'D:/스밀_앱' }))
  on('session.turns', () => ({ value: 3 }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path.endsWith('D:/클로드') || files.has(e.path) }))
  on('fs.read', (_: any, e: any) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({
    answer: 'hi', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' },
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5시간/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Figma/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pdf/ })).toBeDefined()
  await ui.unmount()

  const csv = [...files.entries()].find(([p]) => p.endsWith('.csv'))
  expect(csv).toBeDefined()
  const lines = csv![1].split('\r\n').filter(Boolean)
  expect(lines.length).toBe(2)
  expect(lines[0]!.startsWith('\uFEFF날짜시간')).toBe(true)
  expect(lines[1]!.includes('Bash:1')).toBe(true)
  expect(lines[1]!.includes(',10,20,30,40,')).toBe(true)
})

test('nothing is written where D:/클로드 does not exist', async ($, on) => {
  let wrote = false
  on('session.usage', () => ({ value: USAGE }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: '/home' }))
  on('session.turns', () => ({ value: 1 }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => { wrote = true; return { value: undefined } })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
  expect(wrote).toBe(false)
})
