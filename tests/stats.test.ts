import { expect, test } from 'claude-code/testing'

import { isNewer, reasonOf, NO_FFMPEG } from '../hooks/register'

test('a newer version is spotted, an older or equal one is not', () => {
  expect(isNewer('0.5.0', '0.4.0')).toBe(true)
  expect(isNewer('1.10.0', '1.9.3')).toBe(true)
  expect(isNewer('0.4.0', '0.4.0')).toBe(false)
  expect(isNewer('0.4.0', '0.5.0')).toBe(false)
  expect(isNewer('1.0.0-beta', '0.9.0')).toBe(true)
})

test('a failure is sent as a kind, never its message', () => {
  expect(reasonOf(new Error('ENOENT: /Users/someone/secret/plan.png'))).toBe('missing_file')
  expect(reasonOf(new Error('ffprobe exited 1'))).toBe('video_tools')
  expect(reasonOf(new Error('something odd at /Users/someone'))).toBe('other')
})

test('missing ffmpeg is counted as video tools, not a missing file', () => {
  expect(reasonOf(new Error(NO_FFMPEG))).toBe('video_tools')
  expect(reasonOf(new Error('$.process.run(/opt/homebrew/bin/ffprobe) failed: ENOENT'))).toBe('video_tools')
})

test('the missing-ffmpeg message says how to install it, Homebrew included', () => {
  expect(NO_FFMPEG.includes('brew install ffmpeg')).toBe(true)
  expect(NO_FFMPEG.includes('https://brew.sh')).toBe(true)
  expect(/ENOENT/.test(NO_FFMPEG)).toBe(false)
})
