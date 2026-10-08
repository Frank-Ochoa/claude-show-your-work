import { expect, test } from 'claude-code/testing'

const shown = {
  kind: 'video', path: '/tmp/x/f00001.png', source: '/tmp/x.webm', width: 960, height: 540, title: 'Agent QA', generation: 1,
  frames: { dir: '/tmp/x', count: 20, fps: 12, duration: 1.6 },
}

for (const columns of [140, 90]) {
  test(`the player draws a picture at ${columns} columns`, async $ => {
    const output = `Shown to the user: Agent QA.\nimage-view:${JSON.stringify(shown)}`
    const mounted = await $.ui.mount({
      plugin: 'image-view', surface: 'terminal', component: 'ToolResult', requestId: 'tu-1',
      props: { tool_use_id: 'tu-1', tool: 'mcp__image-view__show_video', output, isErrored: false },
      viewport: { columns, rows: 50 },
    } as any)
    const tree = JSON.stringify(await mounted.drawn())

    expect(tree.includes('"Image"')).toBe(true)
  })
}

test('the window is never wider than the terminal', async $ => {
  for (const columns of [70, 100, 160]) {
    const output = `Shown.\nimage-view:${JSON.stringify(shown)}`
    const mounted = await $.ui.mount({
      plugin: 'image-view', surface: 'terminal', component: 'ToolResult', requestId: `w-${columns}`,
      props: { tool_use_id: `w-${columns}`, tool: 'mcp__image-view__show_video', output, isErrored: false },
      viewport: { columns, rows: 50 },
    } as any)
    const tree = (await mounted.drawn()) as any
    expect(tree.props.width).toBeLessThanOrEqual(columns - 4)
  }
})
