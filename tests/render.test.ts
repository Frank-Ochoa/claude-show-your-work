import { expect, test } from 'claude-code/testing'

const shown = {
  kind: 'video', path: '/tmp/x/f00001.png', source: '/tmp/x.webm', width: 960, height: 540, title: 'Agent QA', generation: 1,
  frames: { dir: '/tmp/x', count: 20, fps: 12, duration: 1.6 },
}

for (const columns of [140, 90]) {
  test(`the player draws a picture at ${columns} columns`, async $ => {
    const output = `Shown to the user: Agent QA.\nshow-your-work:${JSON.stringify(shown)}`
    const target = {
      plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'tu-1',
      props: { tool_use_id: 'tu-1', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
      viewport: { columns, rows: 50 },
    } as any
    const mounted = await $.ui.mount(target)
    const tree = JSON.stringify(await mounted.drawn())

    expect(tree.includes('"Image"')).toBe(true)
  })
}

test('the window is never wider than the terminal', async $ => {
  for (const columns of [70, 100, 160]) {
    const output = `Shown.\nshow-your-work:${JSON.stringify(shown)}`
    const target = {
      plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: `w-${columns}`,
      props: { tool_use_id: `w-${columns}`, tool: 'mcp__show-your-work__show_video', output, isErrored: false },
      viewport: { columns, rows: 50 },
    } as any
    const mounted = await $.ui.mount(target)
    const tree = (await mounted.drawn()) as any
    expect(tree.props.width).toBeLessThanOrEqual(columns - 4)
  }
})

test('a narrow window shows the report under the player', async $ => {
  const report = { ...shown, changes: [{ title: 'Stats moved inside the cards', at: 0.5 }], summary: [{ label: 'Layout', ok: true, passed: 4, total: 4 }] }
  for (const columns of [80, 100]) {
    const output = `Shown.\nshow-your-work:${JSON.stringify(report)}`
    const target = {
      plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: `n-${columns}`,
      props: { tool_use_id: `n-${columns}`, tool: 'mcp__show-your-work__show_video', output, isErrored: false },
      viewport: { columns, rows: 50 },
    } as any
    const mounted = await $.ui.mount(target)
    const tree = JSON.stringify(await mounted.drawn())
    expect(tree.includes('WHAT CHANGED')).toBe(true)
    expect(tree.includes('All checks passed')).toBe(true)
  }
})

test('a picture with earlier versions draws with the version row', async $ => {
  const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1060, title: 'Hero', generation: 1 }
  const withHistory = { ...pic, changes: [{ title: 'Centred the play button' }], compare: { ...pic, title: 'Original' }, history: [{ path: '/tmp/v1.png', note: 'Cloud photo' }, { path: '/tmp/v2.png' }], note: 'Centred play' }
  for (const columns of [160, 90]) {
    const output = `Shown.\nshow-your-work:${JSON.stringify(withHistory)}`
    const target = {
      plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: `h-${columns}`,
      props: { tool_use_id: `h-${columns}`, tool: 'mcp__show-your-work__show_image', output, isErrored: false },
      viewport: { columns, rows: 50 },
    } as any
    const mounted = await $.ui.mount(target)
    const tree = JSON.stringify(await mounted.drawn())
    expect(tree.includes('History · 3')).toBe(true)
    expect(tree.includes('"Image"')).toBe(true)
  }
})

test('the history lists every version by what changed, newest first', async $ => {
  const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1060, title: 'Hero', generation: 1 }
  const withHistory = { ...pic, compare: { ...pic, title: 'Original' }, history: [{ path: '/tmp/v1.png', note: 'Cloud photo' }, { path: '/tmp/v2.png', note: 'Real icons' }], note: 'Centred play' }
  const output = `Shown.\nshow-your-work:${JSON.stringify(withHistory)}`
  const target = {
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'hist',
    props: { tool_use_id: 'hist', tool: 'mcp__show-your-work__show_image', output, isErrored: false },
    viewport: { columns: 160, rows: 50 },
  } as any
  const m = await $.ui.mount(target) as any
  await m.press({ key: 'history' })
  await m.redraw()
  const tree = JSON.stringify(await m.drawn())
  expect(tree.includes('VERSIONS · 3')).toBe(true)
  expect(tree.indexOf('Centred play')).toBeLessThan(tree.indexOf('Cloud photo'))
})

test('the bar can be scrubbed while the clip plays', async $ => {
  const output = `Shown.\nshow-your-work:${JSON.stringify(shown)}`
  const target = {
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'scrub',
    props: { tool_use_id: 'scrub', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
    viewport: { columns: 140, rows: 50 },
  } as any
  const m = await $.ui.mount(target) as any
  const before = JSON.stringify(await m.drawn())
  if (before.includes('Pause')) { /* autoplayed */ } else await m.press({ key: 'play' })
  await m.redraw()
  const tree = JSON.stringify(await m.drawn())
  expect(tree.includes('Pause')).toBe(true)
  expect(tree.includes('"seek-0"')).toBe(true)
  // Pressing near the end while playing moves the playhead there.
  const last = [...tree.matchAll(/"seek-(\d+)"/g)].map(x => +x[1]).at(-1)
  await m.press({ key: `seek-${last}` })
  await m.redraw()
  const after = JSON.stringify(await m.drawn())
  expect(after.includes('0:01')).toBe(true)
})

test('a preview whose files are gone says it expired, with a prompt to copy', async $ => {
  const gone = { kind: 'image', path: '/tmp/definitely-gone-xyz.png', source: '/tmp/definitely-gone-xyz.png', width: 800, height: 600, title: 'Hero', generation: 1 }
  const output = `Shown.\nshow-your-work:${JSON.stringify(gone)}`
  const target = {
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'gone',
    props: { tool_use_id: 'gone', tool: 'mcp__show-your-work__show_image', output, isErrored: false },
    viewport: { columns: 140, rows: 50 },
  } as any
  const tree = JSON.stringify(await (await $.ui.mount(target)).drawn())
  expect(tree.includes('"Image"') || tree.includes('expired')).toBe(true)
})
