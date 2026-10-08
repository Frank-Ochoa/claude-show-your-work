import { expect, test } from 'claude-code/testing'

import { changeAt, checkDiff, isScratch, notesPrompt, toolLine, urlAt, expand, fit, frameFile, parseShown, playWord, sameMoment, sampleRate, sizeFor } from '../hooks/register'

test('a wide image fills the width at half-height rows', () => {
  expect(fit(1920, 1080, 100, 40)).toEqual({ columns: 100, rows: 29 })
})

test('a tall image is limited by rows and narrowed to keep its shape', () => {
  expect(fit(1000, 2000, 100, 30)).toEqual({ columns: 30, rows: 30 })
})

test('sizes stay inside the 1..255 cell limits', () => {
  const box = fit(10000, 10, 400, 40)
  expect(box.columns).toBe(255)
  expect(box.rows).toBe(1)
})

test('the result text round-trips to the shown image', () => {

  const shown = { path: '/tmp/a.png', width: 10, height: 5, title: 'a', generation: 1 }
  const text = `Shown to the user: a (10×5).\nimage-view:${JSON.stringify(shown)}`
  expect(parseShown(text)).toEqual(shown)
  expect(parseShown([{ type: 'text', text }])).toEqual(shown)
  expect(parseShown('nothing here')).toBe(null)
})

test('typed and dragged-in paths resolve', () => {
  expect(expand('~/Movies/Screen\\ Recordings/a.png', '/w', '/Users/u')).toBe('/Users/u/Movies/Screen Recordings/a.png')
  expect(expand("'/tmp/a b.png'", '/w', '/Users/u')).toBe('/tmp/a b.png')
  expect(expand('img/a.png', '/w/', '/Users/u')).toBe('/w/img/a.png')
})

test('long clips are sampled slower so they stay under 900 frames', () => {
  expect(sampleRate(10)).toBe(12)
  expect(sampleRate(150)).toBe(6)
  expect(sampleRate(5000)).toBe(1)
  expect(frameFile({ dir: '/t', count: 3, fps: 12, duration: 1 }, 0)).toBe('/t/f00001.png')
})

test('the picture sizes to the terminal within its limits', () => {
  const wide = sizeFor(1920, 1080, 192, 60, false)
  expect(wide.columns).toBeLessThanOrEqual(120)
  expect(wide.rows).toBeLessThanOrEqual(33)
  const narrow = sizeFor(1920, 1080, 40, 40, false)
  expect(narrow.columns).toBe(40)
  const tiny = sizeFor(1920, 1080, 12, 40, false)
  expect(tiny.columns).toBeGreaterThan(0)
  expect(sizeFor(1920, 1080, 294, 30, true).rows).toBeLessThanOrEqual(18)
})

test('compare keeps the same moment across clips', () => {
  const a = { dir: '/a', count: 200, fps: 12, duration: 16.7 }
  const b = { dir: '/b', count: 60, fps: 6, duration: 10 }
  expect(sameMoment(a, b, 60)).toBe(30)
  expect(sameMoment(a, b, 199)).toBe(59)
})

test('the play control says where the clip is', () => {
  expect(playWord(false, 0, 100)).toBe('▶ Play')
  expect(playWord(false, 40, 100)).toBe('▶ Resume')
  expect(playWord(true, 40, 100)).toBe('❚❚ Pause')
  expect(playWord(false, 99, 100)).toBe('↺ Replay')
})

test('the report says which checks were fixed or broke', () => {
  const before = [{ name: 'a', ok: false }, { name: 'b', ok: true }, { name: 'c', ok: true }]
  const now = [{ name: 'a', ok: true }, { name: 'b', ok: false }, { name: 'c', ok: true }]
  const { fixed, broken } = checkDiff(now, before)
  expect(fixed.map(c => c.name)).toEqual(['a'])
  expect(broken.map(c => c.name)).toEqual(['b'])
})

test('side by side names the latest change up to the moment shown', () => {
  const shown = {
    path: '/a', width: 1, height: 1, title: 't', generation: 1,
    checks: [{ name: 'nav', ok: true, at: 6 }, { name: 'BID', ok: true, at: 8 }, { name: 'Zurich', ok: true, at: 11 }],
    compare: { path: '/b', width: 1, height: 1, title: 'b', generation: 2, checks: [{ name: 'nav', ok: true }, { name: 'BID', ok: false }, { name: 'Zurich', ok: false }] },
  }
  expect(changeAt(shown, 5)).toBe(null)
  expect(changeAt(shown, 9)?.check.name).toBe('BID')
  expect(changeAt(shown, 12)?.check.name).toBe('Zurich')
  expect(changeAt(shown, 12)?.was).toBe(false)
})

test('temp files are scratch, finished work is not', () => {
  expect(isScratch('/tmp/claude-image-view/a.png')).toBe(true)
  expect(isScratch('/private/tmp/claude-501/x/qa.webm')).toBe(true)
  expect(isScratch('/var/folders/rq/x/T/shot.png')).toBe(true)
  expect(isScratch('/Users/u/Movies/launch.mp4')).toBe(false)
})

test('the call row is one short line', () => {
  const line = toolLine('mcp__image-view__show_video', { path: '/tmp/x/qa.webm', title: 'Agent QA', compare: '/tmp/b.webm', compare_label: 'Live', checks: [1, 2, 3] }, false)
  expect(line).toBe('▶ Video · Agent QA · vs Live · 3 checks')
  expect(toolLine('mcp__image-view__show_image', { path: '/a/b/shot.png' }, true)).toBe('▣ Loading image · shot.png')
})

test('open page follows the latest check with a url', () => {
  const shown = { path: '/a', width: 1, height: 1, title: 't', generation: 1, url: 'http://localhost:3000/',
    checks: [{ name: 'a', ok: true, at: 2, url: 'http://localhost:3000/#slide-07' }, { name: 'b', ok: true, at: 6, url: 'http://localhost:3000/#slide-10' }] }
  expect(urlAt(shown, 1)).toBe('http://localhost:3000/')
  expect(urlAt(shown, 3)).toBe('http://localhost:3000/#slide-07')
  expect(urlAt(shown, 9)).toBe('http://localhost:3000/#slide-10')
})

test('notes become a prompt with where, when and the pinned frame', () => {
  const shown = { path: '/a.png', source: '/w/qa.webm', width: 1, height: 1, title: 'Agent QA', generation: 1 }
  const text = notesPrompt(shown, [{ n: 1, at: 7.4, frame: 89, x: 0.25, y: 0.5, text: 'Logo too small', file: '/tmp/p.png' }], true)
  expect(text).toContain('Feedback on "Agent QA" (/w/qa.webm)')
  expect(text).toContain('1. at 0:07, 25% across, 50% down: Logo too small (pinned frame: /tmp/p.png)')
})
