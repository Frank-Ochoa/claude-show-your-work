import { expect, test } from 'claude-code/testing'

import { bucket, isNewer, reasonOf } from '../hooks/register'

test('a newer version is spotted, an older or equal one is not', () => {
  expect(isNewer('0.5.0', '0.4.0')).toBe(true)
  expect(isNewer('1.10.0', '1.9.3')).toBe(true)
  expect(isNewer('0.4.0', '0.4.0')).toBe(false)
  expect(isNewer('0.4.0', '0.5.0')).toBe(false)
  expect(isNewer('1.0.0-beta', '0.9.0')).toBe(true)
})

test('sizes go out as rough ranges, never exact', () => {
  expect(bucket(3, [5, 15, 30])).toBe('<5')
  expect(bucket(12, [5, 15, 30])).toBe('5-15')
  expect(bucket(45, [5, 15, 30])).toBe('30+')
})

test('a failure is sent as a kind, never its message', () => {
  expect(reasonOf(new Error('ENOENT: /Users/someone/secret/plan.png'))).toBe('missing_file')
  expect(reasonOf(new Error('ffprobe exited 1'))).toBe('video_tools')
  expect(reasonOf(new Error('something odd at /Users/someone'))).toBe('other')
})
