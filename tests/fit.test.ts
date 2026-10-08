import { expect, test } from 'claude-code/testing'

import { checkDiff, expand, fit, frameFile, parseShown, playWord, sameMoment, sampleRate, sizeFor } from '../hooks/register'

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
