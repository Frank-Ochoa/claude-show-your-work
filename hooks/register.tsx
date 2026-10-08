import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Check, Frames, KeyChange, Overlay, Shown, Summary } from '../types'

const PANE = 'image-view'
const TOOLS = ['mcp__image-view__show_image', 'mcp__image-view__show_video']
const TMP = '/tmp/claude-image-view'
const MARK = 'image-view:'
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i
// Frames a clip is cut into at most, and the rate it plays at below that.
const MAX_FRAMES = 900
const MAX_FPS = 12
// The window's fill: a step lighter than a dark terminal, so it reads as one panel.
const PANEL = '#2c2e35'
// The QA report beside the picture, and the width the window needs for it.
const SIDE = 40
// The sidebar's fill: darker than the window, so the report stands apart.
const SIDEBAR = '#1d1e23'
const WIDE_ENOUGH = 110
const current = atom({ plugin: 'image-view', key: 'current' } as const, null)

let cwd = ''
let home = ''
let ffmpeg = 'ffmpeg'
let ffprobe = 'ffprobe'
let generation = 0
let pastedNames: string[] = []

// Playback per drawn site (a transcript row's tool_use_id, or the pane).
type Player = {
  frame: number
  timer?: Timer
  isCompare?: boolean
  isSplit?: boolean
  hasAutoplayed?: boolean
  // how many bar cells the scrub row last drew, so playback redraws only on a change
  segments?: number
  // which page of key changes the sidebar shows
  changesPage?: number
  // the picture's size in cells as last drawn, for repaints
  box?: { columns: number; rows: number }
}
const players = new Map<string, Player>()
// Calls made since this load: only these autoplay, not every window a reload redraws.
const freshCalls = new Set<string>()
// Every change that should repaint bumps this; a window's drawing is kept and
// handed back while nothing changed (scrolling only moves which rows show).
let version = 0
const versions = new Map<string, number>()
const drawn = new Map<string, { key: string; tree: unknown }>()

// A change to one window bumps only its own count, so the others hand back
// their kept drawing when the repaint reaches them.
function redraw($: EngineInterface, site?: string) {
  if (site) versions.set(site, (versions.get(site) ?? 0) + 1)
  else version += 1
  $.ui.invalidate('ui.render')
}
const player = (site: string): Player => {
  let one = players.get(site)
  if (!one) players.set(site, (one = { frame: 0 }))

  return one
}

// A typed or dragged-in path: quotes, backslash-escaped spaces and ~ allowed.
export function expand(path: string, base: string, homeDir: string): string {
  let p = path.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1')
  if (p === '~' || p.startsWith('~/')) p = homeDir + p.slice(1)
  if (p.startsWith('/')) return p

  return `${base.replace(/\/$/, '')}/${p}`
}

export const frameFile = (frames: Frames, i: number) => `${frames.dir}/f${String(i + 1).padStart(5, '0')}.png`

// How fast to sample a clip so it stays under MAX_FRAMES.
export const sampleRate = (duration: number) =>
  Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / Math.max(duration, 0.1))))

export const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`

// Finds a pasted image's original file by name with Spotlight (macOS).
async function findPasted($: EngineInterface, name: string): Promise<string | null> {
  if (name.startsWith('/')) return name
  const found = await $.process.run(['mdfind', '-name', name])

  return found.stdout.split('\n').find(line => line.endsWith(`/${name}`)) ?? null
}

async function pngSize($: EngineInterface, png: string) {
  const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png])
  const width = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  if (!width || !height) throw new Error(`not an image: ${png}`)

  return { width, height }
}

// Cuts a clip into PNG frames the terminal can swap through.
async function prepareVideo($: EngineInterface, real: string, title: string): Promise<Shown> {
  const probe = await $.process.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', real])
  const duration = Number(probe.stdout.trim()) || 1
  const fps = sampleRate(duration)
  generation += 1
  const dir = `${TMP}/v${generation}-${Math.floor(await $.clock.now())}`
  await $.process.run(['mkdir', '-p', dir])
  const cut = await $.process.run([
    ffmpeg, '-v', 'error', '-i', real,
    '-vf', `fps=${fps},scale='min(960,iw)':-2`,
    '-frames:v', String(MAX_FRAMES), '-compression_level', '1', `${dir}/f%05d.png`,
  ])
  if (cut.exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: ${cut.stderr.trim().slice(0, 200)}`)
  const count = (await $.fs.list(dir)).filter(f => f.name.endsWith('.png')).length
  if (!count) throw new Error(`no frames in ${real}`)
  const frames = { dir, count, fps, duration }
  const poster = frameFile(frames, 0)

  return { kind: 'video', path: poster, source: real, ...(await pngSize($, poster)), title, generation, frames }
}

// Moments both runs share (a check by the same name), as [updated, original]
// seconds, kept only while both clocks move forward.
export function anchors(updated: Check[] = [], original: Check[] = []): [number, number][] {
  const at = new Map(original.filter(c => c.at !== undefined).map(c => [c.name, c.at!]))
  const pairs = updated
    .filter(c => c.at !== undefined && at.has(c.name))
    .map(c => [c.at!, at.get(c.name)!] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const kept: [number, number][] = []
  for (const p of pairs) {
    const last = kept.at(-1) ?? [0, 0]
    if (p[0] > last[0] + 0.05 && p[1] > last[1] + 0.05) kept.push(p)
  }

  return kept
}

// The original clip's moment that matches a moment of the updated clip.
export function mapTime(points: [number, number][], t: number, endA: number, endB: number): number {
  const all: [number, number][] = [[0, 0], ...points, [endA, endB]]
  for (let i = 1; i < all.length; i++) {
    const [a0, b0] = all[i - 1]!
    const [a1, b1] = all[i]!
    if (t <= a1 || i === all.length - 1) {
      const k = a1 > a0 ? (b1 - b0) / (a1 - a0) : 1
      return Math.max(0, Math.min(endB, b0 + (t - a0) * k))
    }
  }

  return t
}

// The stretches the original is cut into so each lines up with the updated
// clip: [start, end] in the original and how much to stretch it.
export function warpSegments(points: [number, number][], endA: number, endB: number) {
  const all: [number, number][] = [[0, 0], ...points, [endA, endB]]
  const out: { from: number; to: number; stretch: number }[] = []
  for (let i = 1; i < all.length; i++) {
    const [a0, b0] = all[i - 1]!
    const [a1, b1] = all[i]!
    if (b1 - b0 > 0.02 && a1 - a0 > 0.02) out.push({ from: b0, to: b1, stretch: (a1 - a0) / (b1 - b0) })
  }

  return out
}

// Merges the original and updated recordings into one clip, side by side,
// both on the updated clip's clock, so side by side costs one picture a frame.
async function preparePair($: EngineInterface, original: Shown, updated: Shown) {
  const f = updated.frames!
  generation += 1
  const dir = `${TMP}/p${generation}-${Math.floor(await $.clock.now())}`
  await $.process.run(['mkdir', '-p', dir])
  const side = `fps=${f.fps},scale=-2:360,tpad=stop_mode=clone:stop_duration=30`
  // Line the original up with the updated clip on the moments both share, so
  // each step happens at the same time on both sides.
  const cuts = warpSegments(anchors(updated.checks, original.checks), f.duration, original.frames!.duration)
  const warp = cuts.length > 1
    ? cuts.map((c, i) => `[0:v]trim=start=${c.from.toFixed(3)}:end=${c.to.toFixed(3)},setpts=(PTS-STARTPTS)*${c.stretch.toFixed(4)}[w${i}]`).join(';') +
      `;${cuts.map((_, i) => `[w${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0[o];[o]${side}[a]`
    : `[0:v]${side}[a]`
  const made = await $.process.run([
    ffmpeg, '-v', 'error', '-i', original.source!, '-i', updated.source!,
    '-filter_complex', `${warp};[1:v]${side}[b];[a][b]hstack=inputs=2`,
    '-frames:v', String(f.count), '-compression_level', '1', `${dir}/f%05d.png`,
  ])
  if (made.exitCode !== 0) return null
  const count = (await $.fs.list(dir)).filter(x => x.name.endsWith('.png')).length
  if (!count) return null
  const size = await pngSize($, `${dir}/f00001.png`)

  return { pair: { dir, count, fps: f.fps, duration: f.duration }, pairWidth: size.width, pairHeight: size.height }
}

// Resolves a path to something the terminal can draw: a PNG (other image
// formats converted with macOS `sips`), or a video's frames.
async function prepare($: EngineInterface, raw: string, title?: string): Promise<Shown> {
  const path = expand(raw, cwd, home)
  const stat = await $.fs.stat(path, { resolve: true })
  const real = stat.realPath ?? path
  const name = title ?? real.split('/').pop()!
  if (VIDEO.test(real)) return prepareVideo($, real, name)
  let png = real
  if (!/\.png$/i.test(real)) {
    generation += 1
    png = `${TMP}/${real.split('/').pop()!.replace(/\.[^.]+$/, '')}-${generation}.png`
    await $.process.run(['mkdir', '-p', TMP])
    const conv = await $.process.run(['sips', '-s', 'format', 'png', real, '--out', png])
    if (conv.exitCode !== 0) throw new Error(`could not convert ${real}: ${conv.stderr.trim()}`)
  }
  // A picture travels as bytes, at most 2 MiB: shrink a big one.
  const size = await $.fs.stat(png)
  if ((size.size ?? 0) > 1_800_000) {
    generation += 1
    const small = `${TMP}/${png.split('/').pop()!.replace(/\.png$/i, '')}-${generation}-small.png`
    await $.process.run(['mkdir', '-p', TMP])
    await $.process.run(['sips', '-Z', '1800', png, '--out', small])
    png = small
  }
  generation += 1

  return { kind: 'image', path: png, source: real, ...(await pngSize($, png)), title: name, generation }
}

// The tool's text result carries the shown item as `image-view:{json}`;
// the output may be that string or a list of text blocks.
export function parseShown(output: unknown): Shown | null {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? output.map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n')
        : ''
  const line = text.split('\n').find(l => l.startsWith(MARK))
  if (!line) return null
  try {
    return JSON.parse(line.slice(MARK.length)) as Shown
  } catch {
    return null
  }
}

// Fits the picture in a box of cells; a cell is about twice as tall as wide.
export function fit(width: number, height: number, maxCols: number, maxRows: number) {
  let columns = Math.max(1, Math.min(255, maxCols))
  let rows = Math.ceil((columns * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.ceil((rows * 2 * width) / height))
  }

  return { columns: Math.min(255, columns), rows: Math.max(1, Math.min(255, rows)) }
}

// Sizes the picture to the room it has: between a minimum and a maximum
// width, never taller than its share of the screen, aspect kept.
export function sizeFor(width: number, height: number, room: number, rows: number, isPane: boolean) {
  const maxCols = Math.max(Math.min(room, 24), Math.min(room, isPane ? 220 : 120))
  const maxRows = isPane ? Math.max(6, rows - 12) : Math.max(8, Math.min(40, Math.floor(rows * 0.55)))

  return fit(width, height, maxCols, maxRows)
}

// Maps a frame of one clip to the frame at the same moment in another.
export function sameMoment(from: Frames | undefined, to: Frames | undefined, frame: number): number {
  if (!from || !to) return 0

  return Math.max(0, Math.min(to.count - 1, Math.round((frame / from.fps) * to.fps)))
}

// What a check did between the compared side and this one.
export function checkDiff(now: Check[] = [], before: Check[] = []) {
  const was = new Map(before.map(c => [c.name, c.ok]))
  const fixed = now.filter(c => c.ok && was.get(c.name) === false)
  const broken = now.filter(c => !c.ok && was.get(c.name) === true)

  return { fixed, broken }
}

// The play control's word for where the clip is.
export function playWord(isPlaying: boolean, frame: number, count: number) {
  if (isPlaying) return '❚❚ Pause'
  if (frame >= count - 1) return '↺ Replay'

  return frame > 0 ? '▶ Resume' : '▶ Play'
}

const sideOf = (shown: Shown, site: string): Shown =>
  player(site).isCompare && shown.compare ? shown.compare : shown

const plainAt = (media: Shown, frame: number) =>
  media.frames ? frameFile(media.frames, Math.min(frame, media.frames.count - 1)) : media.path


// The compared side's frame at the moment the shown side is at.
const compareFrame = (shown: Shown, frame: number) => {
  const a = shown.frames, b = shown.compare?.frames
  if (!a || !b) return 0
  const t = mapTime(anchors(shown.checks, shown.compare?.checks), frame / a.fps, a.duration, b.duration)
  return Math.max(0, Math.min(b.count - 1, Math.round(t * b.fps)))
}

// Pictures go to the terminal as PNG bytes, not file paths: a background
// session's terminal cannot open files on this machine, bytes always reach it.
const bytes = new Map<string, Promise<string>>()
const sizes = new Map<string, number>()
// Frames held for smooth playback, at most this many bytes of base64.
const KEEP_BYTES = 24 * 1024 * 1024
let held = 0

function forget(file: string) {
  held -= sizes.get(file) ?? 0
  sizes.delete(file)
  bytes.delete(file)
}

type Source = { png: string } | { file: string; format: 'png' }

// Bytes when the file reads; its path as a last resort.
// The terminal reads the file itself: a path crosses, not the picture. Sending
// bytes (b6b8b14) moved ~400 KB a frame and froze playback.
export function pngSource(_$: EngineInterface, file: string): Promise<Source> {
  return Promise.resolve({ file, format: 'png' as const })
}

function pngBytes($: EngineInterface, file: string): Promise<{ png: string }> {
  let hit = bytes.get(file)
  if (!hit) {
    hit = $.fs.read(file, { as: 'bytes' }).then(r => {
      const b64 = (r as { base64: string }).base64
      sizes.set(file, b64.length)
      held += b64.length
      // Oldest first: the frames played longest ago leave.
      while (held > KEEP_BYTES && bytes.size > 1) forget(bytes.keys().next().value!)
      return b64
    })
    bytes.set(file, hit)
    hit.catch(() => forget(file))
  } else {
    // Recently used: move to the back of the line.
    bytes.delete(file)
    bytes.set(file, hit)
  }

  return hit.then(png => ({ png }))
}

// Whether the terminal draws pictures. Some sessions cannot (a background
// session's relay): the first blit says so, and from then on every player
// shows a warning with the way back instead. (Coloured half-block cells were
// tried as a fallback: unreadable.)
let canImage = true
let probed = false
let sessionId = ''

// What draws a picture: the Image's source.
type Pic = { src: Source }

async function picFor($: EngineInterface, file: string, _box: { columns: number; rows: number }): Promise<Pic> {
  return { src: await pngSource($, file) }
}

// After a first draw, asks whether the picture really drew; if the terminal
// can only show the alt text, switches every picture to cells.
function probe($: EngineInterface, site: string, key: string, pic: Pic) {
  if (!canImage || probed) return
  probed = true
  void $.clock.sleep(250).then(async () => {
    const r = await $.ui.blit({ requestId: site, key, source: pic.src })
    if (r.deny && /alt/i.test(r.deny)) {
      canImage = false
      $.ui.toast("This background session can't draw pictures: see the warning in the chat.")
      redraw($)
    }
  }, () => undefined)
}

// Reads the next few frames ahead so playback never waits on a read.
function prefetch($: EngineInterface, media: Shown, frame: number, box?: { columns: number; rows: number }) {
  if (!media.frames) return
  for (let i = 1; i <= 4; i++) {
    if (frame + i >= media.frames.count) break
    void plainAt(media, frame + i)
  }
}

async function blit($: EngineInterface, site: string, key: string, media: Shown, file: string, frame: number) {
  const box = player(site).box
  prefetch($, media, frame, box)
  if (canImage) await $.ui.blit({ requestId: site, key, source: await pngSource($, file) })
}

function draw($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  if (one.isSplit && shown?.pair) {
    const at = Math.min(one.frame, shown.pair.count - 1)
    void blit($, site, 'view-pair', shown, frameFile(shown.pair, at), at).catch(() => undefined)
    return
  }
  if (one.isSplit && shown?.compare) {
    const at = compareFrame(shown, one.frame)
    void blit($, site, 'view-a', shown.compare, plainAt(shown.compare, at), at).catch(() => undefined)
    void blit($, site, 'view-b', shown, plainAt(shown, one.frame), one.frame).catch(() => undefined)
    return
  }
  void blit($, site, 'view', media, plainAt(media, one.frame), one.frame).catch(() => undefined)
}

// A side's checks in words: "4 checks fail" or "all 11 checks pass".
export function resultWords(checks: Check[] = []): string {
  const failing = checks.filter(c => !c.ok).length
  if (!checks.length) return ''
  return failing ? `${failing} ${failing === 1 ? 'check fails' : 'checks fail'}` : `all ${checks.length} checks pass`
}

// The latest check up to a moment whose result differs between the sides.
export function changeAt(shown: Shown, seconds: number): { check: Check; was: boolean } | null {
  const before = new Map((shown.compare?.checks ?? []).map(c => [c.name, c.ok]))
  const differing = (shown.checks ?? []).filter(c => before.has(c.name) && before.get(c.name) !== c.ok && (c.at ?? 0) <= seconds)
  const last = differing.at(-1)

  return last ? { check: last, was: before.get(last.name)! } : null
}

function stop($: EngineInterface, site: string) {
  const one = player(site)
  one.timer?.cancel()
  one.timer = undefined
  redraw($, site)
}

function play($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  const frames = media.frames
  if (one.timer || !frames) return
  // One video plays at a time: starting this one pauses the rest.
  for (const [other, p] of players) {
    if (other !== site && p.timer) {
      p.timer.cancel()
      p.timer = undefined
      versions.set(other, (versions.get(other) ?? 0) + 1)
    }
  }
  if (one.frame >= frames.count - 1) one.frame = 0
  // The picture swaps every frame; the bar and the time redraw once a second.
  // A redraw repaints every player window in the chat, so it stays rare.
  const marks = () => String(Math.floor(one.frame / frames.fps))
  let last = marks()
  one.timer = $.clock.every(Math.round(1000 / frames.fps), () => {
    if (one.frame >= frames.count - 1) return stop($, site)
    one.frame += 1
    draw($, site, media, shown)
    const now = marks()
    if (now !== last) {
      last = now
      redraw($, site)
    }
  })
  redraw($, site)
}

const toggle = ($: EngineInterface, site: string, media: Shown, shown?: Shown) =>
  player(site).timer ? stop($, site) : play($, site, media, shown)

function seek($: EngineInterface, site: string, media: Shown, seconds: number, shown?: Shown) {
  const frames = media.frames
  if (!frames) return
  player(site).frame = Math.max(0, Math.min(frames.count - 1, Math.round(seconds * frames.fps)))
  draw($, site, media, shown)
  redraw($, site)
}

function flip($: EngineInterface, site: string, shown: Shown, toCompare: boolean) {
  const one = player(site)
  if (!shown.compare || !!one.isCompare === toCompare) return
  const from = sideOf(shown, site)
  const wasPlaying = !!one.timer
  one.timer?.cancel()
  one.timer = undefined
  one.isCompare = toCompare
  const to = sideOf(shown, site)
  // Same moment on the other side, lined up on the steps both runs share.
  if (toCompare) one.frame = compareFrame(shown, one.frame)
  else if (from.frames && to.frames) {
    const back = anchors(shown.checks, shown.compare.checks).map(([a, b]) => [b, a] as [number, number])
    const t = mapTime(back, one.frame / from.frames.fps, from.frames.duration, to.frames.duration)
    one.frame = Math.max(0, Math.min(to.frames.count - 1, Math.round(t * to.frames.fps)))
  }
  draw($, site, to)
  if (wasPlaying && to.frames) play($, site, to)
  redraw($, site)
}

// Side by side: both sides at once, locked to the same moment, the shown
// side's clock driving both.
function split($: EngineInterface, site: string, shown: Shown, on: boolean) {
  const one = player(site)
  if (!shown.compare || (on && !shown.pair) || !!one.isSplit === on) return
  const wasPlaying = !!one.timer
  one.timer?.cancel()
  one.timer = undefined
  if (one.isCompare) one.frame = sameMoment(shown.compare.frames, shown.frames, one.frame)
  one.isCompare = false
  one.isSplit = on
  if (wasPlaying) play($, site, shown, shown)
  redraw($, site)
}

type Ui = any
type Box = { columns: number; rows: number }

// The picture.
function Picture(ui: Ui, $: EngineInterface, site: string, shown: Shown, media: Shown, box: Box, pic: Pic) {
  const { Text, Image } = ui
  if (!Image) return <Text dimColor>This surface cannot draw images.</Text>

  // The picture stands alone: no wrapper, nothing laid over it and no fill
  // behind it. Each of those kept the picture from drawing in Ghostty.
  return (
    <Image
      key="view"
      source={pic.src}
      columns={box.columns}
      rows={box.rows}
      alt={`[${media.kind ?? 'image'}: ${shown.title}]`}
    />
  )
}

// The scrub row: the play control, elapsed, a clickable bar, total — exactly
// as wide as the picture.
function Scrub(ui: Ui, $: EngineInterface, site: string, media: Shown, width: number, shown?: Shown) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const frames = media.frames!
  const word = playWord(!!one.timer, one.frame, frames.count)
  const elapsed = clock(one.frame / frames.fps)
  const total = clock(frames.duration)
  const segments = Math.max(6, width - (word.length + 4) - elapsed.length - total.length - 4)
  const playhead = Math.min(segments - 1, Math.round((one.frame / Math.max(1, frames.count - 1)) * (segments - 1)))
  one.segments = segments

  // Playing: the bar is one cheap line of text. Paused: every cell is a button
  // that jumps there.
  if (one.timer) {
    return (
      <Box flexDirection="row" flexWrap="nowrap" width={width}>
        <Button key="play" variant="primary" label={word} onPress={() => toggle($, site, media, shown)} />
        <Text dimColor> {elapsed} </Text>
        <Text>{'━'.repeat(playhead)}●</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, segments - playhead - 1))}</Text>
        <Text dimColor> {total}</Text>
      </Box>
    )
  }

  // Paused: the bar is ~20 wide buttons, each a stretch you can jump to.
  const chunks = barChunks(segments, playhead)

  return (
    <Box flexDirection="row" flexWrap="nowrap" width={width}>
      <Button key="play" variant="primary" label={word} onPress={() => toggle($, site, media, shown)} />
      <Text dimColor> {elapsed} </Text>
      {chunks.map((c, i) => (
        <Button
          key={`seek-${i}`}
          plain
          dimColor={c.isAhead}
          label={c.label}
          onPress={() => seek($, site, media, (c.start / Math.max(1, segments - 1)) * frames.duration, shown)}
        />
      ))}
      <Text dimColor> {total}</Text>
    </Box>
  )
}

// Splits the bar's cells into ~20 stretches: played cells '━', the playhead
// '●', the rest '─'; a stretch is dim once it lies ahead.
export function barChunks(segments: number, playhead: number, count = 20) {
  const size = Math.max(1, Math.ceil(segments / count))
  const chunks: { start: number; label: string; isAhead: boolean }[] = []
  for (let start = 0; start < segments; start += size) {
    let label = ''
    for (let i = start; i < Math.min(segments, start + size); i++) {
      label += i === playhead ? '●' : i < playhead ? '━' : '─'
    }
    chunks.push({ start, label, isAhead: start > playhead })
  }

  return chunks
}

// Original / Updated / Both side by side: the view shown is the accent button.
function Tabs(ui: Ui, $: EngineInterface, site: string, shown: Shown) {
  const { Box, Button } = ui
  if (!shown.compare) return null
  const one = player(site)
  const isBoth = !!one.isSplit
  const isCompare = !isBoth && !!one.isCompare
  const isUpdated = !isBoth && !isCompare
  const canBoth = !!(shown.frames && shown.pair)
  const pick = (toCompare: boolean) => () => {
    if (isBoth) split($, site, shown, false)
    flip($, site, shown, toCompare)
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Button key="side-before" variant={isCompare ? 'primary' : 'secondary'} label={shown.compare.label ?? 'Original'} onPress={pick(true)} />
      <Button key="side-after" variant={isUpdated ? 'primary' : 'secondary'} label={shown.label ?? 'Updated'} onPress={pick(false)} />
      {canBoth && <Button key="side-both" variant={isBoth ? 'primary' : 'secondary'} label="⧉ Both" onPress={() => split($, site, shown, true)} />}
    </Box>
  )
}

// The QA report beside the picture: the change, its PR, the checks and what
// flipped against the compared side.
// What was fixed or broke; each row jumps to its moment.
function Changes(ui: Ui, $: EngineInterface, site: string, shown: Shown, fixed: Check[], broken: Check[]) {
  const { Box, Button } = ui
  const media = sideOf(shown, site)
  const row = (c: Check, word: string) => (
    <Button
      key={`${word}-${c.name}`}
      plain
      label={`${c.at !== undefined ? clock(c.at) + ' ' : ''}${word} · ${c.name}`}
      onPress={() => c.at !== undefined && seek($, site, media, c.at, shown)}
    />
  )

  return (
    <Box flexDirection="column">
      {fixed.map(c => row(c, '✓ fixed'))}
      {broken.map(c => row(c, '✗ broke'))}
    </Box>
  )
}

// The QA line on top: how many checks passed, from the summary or the checks.
export function qaTotals(summary: Summary[] = [], checks: Check[] = []) {
  if (summary.some(s => s.total !== undefined)) {
    const total = summary.reduce((n, s) => n + (s.total ?? 0), 0)
    const passed = summary.reduce((n, s) => n + (s.passed ?? (s.ok ? s.total ?? 0 : 0)), 0)
    return { passed, total }
  }

  return { passed: checks.filter(c => c.ok).length, total: checks.length }
}

const PILL = '#30323b'
const INNER = SIDE - 4 /* padding */ - 4 /* card border + padding */

// Rows the sidebar spends on everything but the change rows.
export function changesThatFit(height: number, summaryLines: number, hasPr: boolean, hasCompare: boolean) {
  const qa = summaryLines >= 0 ? 1 /* divider */ + 1 /* label */ + 2 /* card border */ + 1 /* total */ + summaryLines : 0
  const footer = hasPr ? 2 /* divider + PR */ : 0
  const tabs = hasCompare ? 2 /* tabs + divider */ : 0
  const fixed = 2 /* padding */ + tabs + 1 /* label */ + 2 /* card border */ + qa + footer
  return Math.max(1, height - fixed)
}

// A title cut to fit one row, so a long one never pushes the rows down.
export const cut = (text: string, width: number) => (text.length <= width ? text : text.slice(0, Math.max(1, width - 1)) + '…')

// The sidebar, exactly as tall as the player: the Original / Updated / Both
// switch fixed on top, then cards for what changed (each one jumps to its
// moment; the one playing now is lit) and the QA in three lines, then the PR.
function Report(ui: Ui, $: EngineInterface, site: string, shown: Shown, prLink: Ui, height: number) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const changes: KeyChange[] = shown.changes?.length ? shown.changes : shown.change ? [{ title: shown.change }] : []
  const summary = (shown.summary ?? []).slice(0, 3)
  const { passed, total } = qaTotals(summary, media.checks)
  const allPass = total > 0 && passed === total
  const room = changesThatFit(height, total > 0 ? summary.length : -1, !!prLink, !!shown.compare)
  const pages = Math.max(1, Math.ceil(changes.length / room))
  const page = Math.min(one.changesPage ?? 0, pages - 1)
  const shownChanges = changes.slice(page * room, page * room + room)
  const now = media.frames ? one.frame / media.frames.fps : -1
  const live = changes.reduce((hit, c, i) => (c.at !== undefined && c.at <= now ? i : hit), -1)
  const rule = <Text color="subtle">{'─'.repeat(SIDE - 4)}</Text>
  const label = (text: string, right?: Ui) => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor bold>{text}</Text>
      {right}
    </Box>
  )

  return (
    <Box flexDirection="column" width={SIDE} height={height} overflow="hidden" backgroundColor={SIDEBAR} paddingX={2} paddingY={1}>
      {shown.compare && (
        <Box flexDirection="column">
          {Tabs(ui, $, site, shown)}
          {rule}
        </Box>
      )}
      {label(
        `WHAT CHANGED · ${changes.length}`,
        pages > 1 ? (
          <Button
            key="changes-more"
            plain
            dimColor
            label={`${page + 1}/${pages} ↓`}
            onPress={() => {
              one.changesPage = (page + 1) % pages
              redraw($, site)
            }}
          />
        ) : undefined,
      )}
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        {shownChanges.map((c, i) => {
          const n = page * room + i
          const isLive = n === live
          const time = c.at !== undefined ? ` ${clock(c.at)} ` : ''
          return (
            <Box key={`change-${n}`} flexDirection="row" justifyContent="space-between" height={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={isLive ? 'suggestion' : undefined} dimColor={!isLive}>{`${n + 1}.`.padStart(3)}</Text>
                <Button
                  key={`change-${n}`}
                  plain
                  label={cut(c.title, INNER - 5 - time.length)}
                  onPress={() => c.at !== undefined && seek($, site, media, c.at, shown)}
                />
              </Box>
              {time && (
                <Text backgroundColor={isLive ? 'suggestion' : PILL} color={isLive ? 'inverseText' : undefined}>
                  {time}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
      {total > 0 && (
        <Box flexDirection="column">
          {rule}
          {label('QA', <Text bold color={allPass ? 'success' : 'error'}>{passed}/{total}</Text>)}
          <Box flexDirection="column" borderStyle="round" borderColor={allPass ? 'success' : 'error'} borderDimColor paddingX={1}>
            <Text bold color={allPass ? 'success' : 'error'}>
              {allPass ? '✓ All checks passed' : `✗ ${total - passed} of ${total} checks failed`}
            </Text>
            {summary.map(s => (
              <Box key={`sum-${s.label}`} flexDirection="row" justifyContent="space-between" height={1}>
                <Text>
                  <Text color={s.ok ? 'success' : 'error'}>{s.ok ? '✓' : '✗'}</Text> {cut(s.label, INNER - 8)}
                </Text>
                {s.total !== undefined && <Text dimColor>{s.passed ?? (s.ok ? s.total : 0)}/{s.total}</Text>}
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {prLink && (
        <Box flexDirection="column">
          {rule}
          <Box flexDirection="row" gap={1}><Text dimColor>PR</Text>{prLink}</Box>
        </Box>
      )}
    </Box>
  )
}

// Scratch output lives in temp folders; finished work lives somewhere real.
export const isScratch = (path: string) => /^\/(private\/)?(tmp|var\/folders)\//.test(path)

// What you do with the file: watch it properly, keep it (or find it), or
// paste its path elsewhere.
function Actions(ui: Ui, $: EngineInterface, media: Shown, source: string, isNarrow: boolean) {
  const { Box, Button } = ui
  const done = (r: { exitCode: number; stderr: string }, note: string) =>
    $.ui.toast(r.exitCode === 0 ? note : `Could not: ${r.stderr.trim().slice(0, 120)}`)
  const name = source.split('/').pop()!
  const keep = async () => {
    const out = `${home}/Downloads/${name}`
    const r = await $.process.run(['cp', '-n', source, out])
    if (r.exitCode === 0) await $.process.run(['open', '-R', out])
    done(r, `Saved to Downloads/${name}`)
  }

  return (
    <Box flexDirection="row" gap={2}>
      {!source.startsWith(`${home}/Downloads/`) ? (
        <Button key="keep" plain dimColor label="Save to Downloads" onPress={() => void keep()} />
      ) : (
        <Button key="reveal" plain dimColor label="Show in Finder" onPress={() => void $.process.run(['open', '-R', source]).then(r => done(r, 'Shown in Finder'))} />
      )}
      {!isNarrow && (
        <Button
          key="copy"
          plain
          dimColor
          label="Copy path"
          onPress={(press: { surface: 'terminal' }) =>
            void $.ui.copy({ text: source, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path'))
          }
        />
      )}
    </Box>
  )
}

// The page the moment shows: the latest check's url up to now, else the item's.
export function urlAt(shown: Shown, seconds: number): string | undefined {
  const hit = (shown.checks ?? []).filter(c => c.url && (c.at ?? 0) <= seconds).at(-1)

  return hit?.url ?? shown.url
}

// Shown while pictures are drawn as cells: why, and the way back to full quality.
// Resumes this chat outside the background service, so pictures draw again.
export const resumeCommand = (id: string) =>
  `CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume${id ? ' ' + id : ''}`

// The whole window, while pictures can't draw here: a warning with the way
// back to full quality, and the blocky preview only if asked for.
function Warning(ui: Ui, $: EngineInterface, site: string, shown: Shown, width: number) {
  const { Box, Text, Button } = ui
  const command = resumeCommand(sessionId)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={2} paddingY={1} width={Math.max(40, Math.min(width, 96))}>
      <Text bold color="warning">⚠ Can't show {shown.frames ? 'videos' : 'pictures'} in a background session</Text>
      <Text wrap="wrap">
        {'\n'}"{shown.title}" is ready, but this chat is running as a background session, and those can't draw pictures in the terminal. Resume this chat in a normal Ghostty tab to see it at full quality:
      </Text>
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Text bold>{command}</Text>
      </Box>
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button
          key="copy-resume"
          variant="primary"
          label="Copy command"
          onPress={(press: { surface: 'terminal' }) =>
            void $.ui.copy({ text: command, surface: press.surface }).then(r =>
              $.ui.toast(r.isCopied ? 'Copied. Paste it in a new Ghostty tab.' : 'Could not copy'),
            )
          }
        />
      </Box>
    </Box>
  )
}

// The player: concept A (picture, scrub row, controls) everywhere; concept B
// (A plus the QA report at its side) when there is a report and room for it.
async function Viewer(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  shown: Shown,
  site: string,
  isPane: boolean,
  viewport: { columns: number; rows: number } | undefined,
) {
  const ui = $.ui.resolve(e) as Ui
  const { Box, Text, Button, Link } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const frames = media.frames
  const source = media.source ?? media.path
  const columns = viewport?.columns ?? 100
  const hasReport = !!(shown.change || shown.changes?.length || shown.summary?.length || shown.checks?.length)
  const isWide = hasReport && columns - 8 >= WIDE_ENOUGH
  const room = columns - (isPane ? 6 : 10) - (isWide ? SIDE + 3 : 0)
  const box = sizeFor(shown.width, shown.height, room, viewport?.rows ?? 40, isPane)
  const isNarrow = box.columns < 60
  const checks = media.checks ?? []
  const passed = checks.filter(c => c.ok).length
  const prNumber = shown.pr?.match(/\/pull\/(\d+)/)?.[1]
  const prLabel = prNumber ? `PR #${prNumber}` : shown.pr
  const prLink = shown.pr
    ? /^https?:\/\//.test(shown.pr)
      ? <Link href={shown.pr} label={prLabel} />
      : <Text color="suggestion">{prLabel}</Text>
    : null
  const run = (argv: string[], note: string) => () => {
    void $.process.run(argv).then(r => $.ui.toast(r.exitCode === 0 ? note : `Could not: ${r.stderr.trim()}`))
  }
  // A video the agent shows starts playing by itself, once.
  if (frames && !isPane && !one.hasAutoplayed && freshCalls.has(site)) {
    one.hasAutoplayed = true
    void $.clock.sleep(400).then(() => play($, site, media, shown), () => undefined)
  }

  // The single view with the QA sidebar is the default; side by side is a click away.
  if (!canImage) {
    one.timer?.cancel()
    one.timer = undefined
    return Warning(ui, $, site, shown, columns - 8)
  }
  one.box = { columns: box.columns, rows: box.rows }
  const pic = await picFor($, plainAt(media, one.frame), box)
  probe($, site, 'view', pic)
  if (one.isSplit && shown.pair && frames) return SplitView(ui, $, site, shown, columns, viewport?.rows ?? 40, isPane, prLink)

  const actions = Actions(ui, $, media, source, isNarrow)
  // The top corner opens it: the page it shows, else the file itself.
  const page = urlAt(media, frames ? one.frame / frames.fps : 0) ?? (/\.html?$/i.test(source) ? source : undefined)
  const opener = (
    <Button
      key="page"
      plain
      label={page ? '↗ Open page' : '↗ View'}
      onPress={() =>
        void $.process.run(['open', page ?? source]).then(r =>
          $.ui.toast(r.exitCode === 0 ? `Opened ${(page ?? source.split('/').pop()!).slice(0, 60)}` : 'Could not open it'),
        )
      }
    />
  )

  const stage = (
    <Box flexDirection="column" width={box.columns}>
      {Picture(ui, $, site, shown, media, box, pic)}
      {frames && Scrub(ui, $, site, media, box.columns, shown)}
      <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap" width={box.columns}>
        <Box flexDirection="row" columnGap={2}>
          {frames && <Button key="back" plain dimColor label="« 5s" onPress={() => seek($, site, media, one.frame / frames.fps - 5, shown)} />}
          {frames && <Button key="forward" plain dimColor label="5s »" onPress={() => seek($, site, media, one.frame / frames.fps + 5, shown)} />}
          {!isWide && Tabs(ui, $, site, shown)}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {opener}
          {actions}
        </Box>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={box.columns + (isWide ? SIDE + 3 : 0) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={2} flexShrink={1}>
          <Text bold wrap="truncate-end">{shown.title}</Text>
          {checks.length > 0 && (
            <Text bold color={passed === checks.length ? 'success' : 'error'}>
              {passed === checks.length ? '✓' : '✗'} {passed}/{checks.length}
            </Text>
          )}
        </Box>
        <Text dimColor>{frames ? `${media.width}×${media.height} · ${clock(frames.duration)}` : `${media.width}×${media.height}`}</Text>
      </Box>
      {!isWide && (shown.change || prLink) && (
        <Box flexDirection="row" gap={2}>
          {prLink}
          {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
        </Box>
      )}
      <Box flexDirection="row" gap={3} marginTop={1}>
        {stage}
        {isWide && Report(ui, $, site, shown, prLink, box.rows + (frames ? 3 : 2))}
      </Box>
    </Box>
  )
}

// Both sides at once: names and scores over each, the change at this moment
// spelled out under them, one scrub row, and the list of changes.
async function SplitView(
  ui: Ui,
  $: EngineInterface,
  site: string,
  shown: Shown,
  columns: number,
  rows: number,
  isPane: boolean,
  prLink: Ui,
) {
  const { Box, Text, Image, Button } = ui
  const one = player(site)
  const before = shown.compare!
  const pair = shown.pair!
  // One merged clip, Original left and Updated right: one picture per frame.
  const box = sizeFor(shown.pairWidth ?? shown.width * 2, shown.pairHeight ?? shown.height, columns - (isPane ? 6 : 10), rows, isPane)
  const width = box.columns
  const half = Math.floor(width / 2)
  const seconds = one.frame / shown.frames!.fps
  const change = changeAt(shown, seconds)
  const { fixed, broken } = checkDiff(shown.checks, before.checks)
  one.box = { columns: box.columns, rows: box.rows }
  const pic = await picFor($, frameFile(pair, Math.min(one.frame, pair.count - 1)), box)
  probe($, site, 'view-pair', pic)
  const head = (s: Shown, fallback: string) => {
    const words = resultWords(s.checks)
    const ok = (s.checks ?? []).every(c => c.ok)
    return (
      <Box width={half} flexDirection="row" gap={1}>
        <Text bold>{s.label ?? fallback}</Text>
        {words && <Text color={ok ? 'success' : 'error'}>· {words}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={width + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2} width={width}>
        <Text bold wrap="truncate-end">{shown.title}</Text>
        <Box flexDirection="row" gap={2}>
          {prLink}
          {Tabs(ui, $, site, shown)}
        </Box>
      </Box>
      {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
      <Box flexDirection="row" marginTop={1} width={width}>
        {head(before, 'Original')}
        {head(shown, 'Updated')}
      </Box>
      {Image ? (
        <Image key="view-pair" source={pic.src} columns={box.columns} rows={box.rows} alt="[original and updated, side by side]" />
      ) : (
        <Text dimColor>This surface cannot draw images.</Text>
      )}
      <Box width={width}>
        {change ? (
          <Text wrap="truncate-end">
            <Text dimColor>{clock(change.check.at ?? 0)} · </Text>
            {change.check.name}
            <Text dimColor> · </Text>
            <Text color={change.was ? 'success' : 'error'}>{before.label ?? 'Original'} {change.was ? '✓' : '✗'}</Text>
            <Text dimColor> → </Text>
            <Text color={change.check.ok ? 'success' : 'error'}>{shown.label ?? 'Updated'} {change.check.ok ? '✓' : '✗'}</Text>
          </Text>
        ) : (
          <Text dimColor>Same so far: both sides match up to {clock(seconds)}</Text>
        )}
      </Box>
      {Scrub(ui, $, site, shown, width, shown)}
      <Box width={width} justifyContent="flex-end">{Actions(ui, $, shown, shown.source ?? shown.path, width < 60)}</Box>
      {(fixed.length > 0 || broken.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{fixed.length} fixed · {broken.length} broke · click one to jump there</Text>
          {Changes(ui, $, site, shown, fixed, broken)}
        </Box>
      )}
    </Box>
  )
}

// The one line a show call's row reads: what it shows, and what with.
export function toolLine(tool: string, input: unknown, isRunning: boolean): string {
  const i = (input ?? {}) as { path?: string; title?: string; compare?: string; compare_label?: string; checks?: unknown[] }
  const what = i.title ?? i.path?.split('/').pop() ?? ''
  const extra = [
    i.compare ? `vs ${i.compare_label ?? i.compare.split('/').pop()}` : '',
    i.checks?.length ? `${i.checks.length} checks` : '',
  ].filter(Boolean)
  const verb = tool.endsWith('video') ? (isRunning ? 'Cutting video' : 'Video') : isRunning ? 'Loading image' : 'Image'

  return `${tool.endsWith('video') ? '▶' : '▣'} ${verb} · ${what}${extra.length ? ' · ' + extra.join(' · ') : ''}`
}

const CHECKS = {
  type: 'array',
  description: 'For QA: the checks run, each { name, ok, at? (seconds into the clip), url? (the page at that moment) }',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, ok: { type: 'boolean' }, at: { type: 'number' }, url: { type: 'string' } },
    required: ['name', 'ok'],
  },
}

const TOOL_INPUT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path to the file (the "after" side when comparing)' },
    title: { type: 'string', description: 'Short caption: what it is' },
    change: { type: 'string', description: 'For QA: one line on what changed' },
    pr: { type: 'string', description: 'For QA: the PR URL or number this belongs to' },
    url: { type: 'string', description: 'The page this shows (a localhost or deployed URL): adds an Open page button' },
    changes: {
  type: 'array',
  description: 'The key changes to review, newest work first: each { title (a few words), detail?, at? (seconds into the clip), url? }',
  items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, at: { type: 'number' }, url: { type: 'string' } }, required: ['title'] },
},
    summary: {
  type: 'array',
  description: 'The QA in at most 3 lines, grouping the checks: each { label, ok, passed?, total? }',
  items: { type: 'object', properties: { label: { type: 'string' }, ok: { type: 'boolean' }, passed: { type: 'number' }, total: { type: 'number' } }, required: ['label', 'ok'] },
},
    checks: CHECKS,
    compare: { type: 'string', description: 'For QA: absolute path to the original version (before the change), image or video; adds Original/Updated tabs' },
    compare_checks: { ...CHECKS, description: 'For QA: the same checks run on the compared side' },
    label: { type: 'string', description: 'Name of this side when comparing (default "Updated")' },
    compare_label: { type: 'string', description: 'Name of the compared side (default "Original")' },
    overlay: {
      type: 'string',
      enum: ['center', 'none'],
      description: 'A centre play button over a paused video (default), or none',
    },
  },
  required: ['path'],
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = started.cwd
    sessionId = await $.session.id().catch(() => '')
    const env = await $.process.run(['sh', '-lc', 'printf "%s\\n" "$HOME"; command -v ffmpeg; command -v ffprobe'])
    const [h, ff, fp] = env.stdout.split('\n')
    home = h ?? ''
    ffmpeg = ff || '/opt/homebrew/bin/ffmpeg'
    ffprobe = fp || '/opt/homebrew/bin/ffprobe'
    // Frames are ~0.3 MB each: keep only the newest few clips' worth.
    void $.process.run(['sh', '-c', `ls -dt ${TMP}/v* 2>/dev/null | tail -n +7 | xargs rm -rf`])
    // Converted pictures older than two days go too.
    void $.process.run(['sh', '-c', `find ${TMP} -maxdepth 2 -type f -mtime +2 -delete 2>/dev/null; true`])
    await $.command.register({
      name: 'img',
      description: 'Show an image or video in a pane: /img <path>',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        "Show a local image (PNG, JPEG, WebP, GIF, TIFF) inline in the user's terminal, in a player window with Open, Reveal and Copy. " +
        "Use it unasked whenever you've made visual work the user should see: a rendered slide or page, a before/after, a chart, a mockup. " +
        'For work that changes something, pass change, pr, checks and compare (the before file): the window adds a QA report and Before/After tabs. ' +
        'The user sees the picture and you do not get it back, so Read the image only when you must check it yourself.',
      inputSchema: TOOL_INPUT,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_video',
      description:
        "Play a local video (MP4, MOV, WebM, GIF) inline in the user's terminal in a player: it starts by itself, with Play/Pause, a clickable progress bar and seek. " +
        'Use it to show recordings you made: a Playwright run clicking through and checking a page, a rendered animation or film cut. ' +
        'For work that changes something, pass change, pr, checks (with at = seconds) and compare (the before recording, with compare_checks): ' +
        'the window adds a QA report, what was fixed or broke, and synced Before/After tabs. ' +
        'Clips are cut into frames (up to 900 at up to 12 fps, 960 px wide), so keep them short. You do not see the video.',
      inputSchema: TOOL_INPUT,
      isDeferred: false,
    })

    return started
  })

  on('prompt.submit', ($, e, next) => {
    pastedNames = (e.attachments ?? []).filter(a => a.type === 'image' && a.filename).map(a => a.filename!)

    return next(e)
  })

  on('command.run', { command: 'img' }, async ($, e) => {
    let arg = e.args.trim()
    if (/^\[Image #\d+\]$/.test(arg) || (!arg && pastedNames.length > 0)) {
      const name = pastedNames.at(-1)
      const found = name ? await findPasted($, name) : null
      if (!found) {
        return {
          text: 'Pasted images reach Claude, not mods, so /img cannot read one. Drag the file into the prompt (that types its path) or type the path: /img ~/path/to/file.png',
        }
      }
      arg = found
    }
    if (!arg) return { text: 'Usage: /img <path>' }
    try {
      const shown = await prepare($, arg)
      stop($, PANE)
      Object.assign(player(PANE), { frame: 0, isCompare: false, hasAutoplayed: true })
      await update($, current, () => shown)
      await $.ui.open({ id: PANE, title: shown.title })

      return { text: `Showing ${shown.title} (${shown.width}×${shown.height}).` }
    } catch (err) {
      return { text: `Could not show it: ${(err as Error).message.replace(/^.*?failed: ENOENT$/, 'no such file')}` }
    }
  })

  on('tool.call', { tool: /^mcp__image-view__show_(image|video)$/ }, async ($, e) => {
    freshCalls.add(e.tool_use_id)
    const input = e as unknown as {
      path?: string; title?: string; change?: string; pr?: string; changes?: KeyChange[]; summary?: Summary[]; url?: string; checks?: Check[]
      compare?: string; compare_checks?: Check[]; label?: string; compare_label?: string; overlay?: Overlay
    }
    if (!input.path) return { deny: 'A path is needed.' }
    try {
      const shown: Shown = {
        ...(await prepare($, input.path, input.title)),
        change: input.change,
        pr: input.pr,
        url: input.url,
        checks: input.checks,
        changes: input.changes,
        summary: input.summary,
        label: input.label,
        overlay: input.overlay,
      }
      if (input.compare) {
        shown.compare = {
          ...(await prepare($, input.compare, input.compare_label ?? 'Original')),
          label: input.compare_label,
          checks: input.compare_checks,
        }
        if (shown.frames && shown.compare.frames) Object.assign(shown, (await preparePair($, shown.compare, shown)) ?? {})
      }
      const what = shown.frames ? `video, ${clock(shown.frames.duration)}` : `${shown.width}×${shown.height}`

      return { result: `Shown to the user: ${shown.title} (${what}).\n${MARK}${JSON.stringify(shown)}` }
    } catch (err) {
      return { deny: `image-view: ${(err as Error).message}` }
    }
  }).catch(() => ({ deny: 'image-view: it could not be shown.' }))

  // The call's own row: one short line, not the whole input.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const props = e.props as { tool: string; input: unknown; isRunning: boolean }
    if (!TOOLS.includes(props.tool)) return next(e)
    const { Text } = $.ui.resolve(e) as Ui

    return <Text>{toolLine(props.tool, props.input, props.isRunning)}</Text>
  })

  // Inline in the transcript: the player is the tool's result row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const props = e.props as { tool: string; output: unknown; isErrored: boolean; onScreen?: unknown }
    if (!TOOLS.includes(props.tool) || props.isErrored) return next(e)
    // Scrolled out of view: stop playing, and don't start there.
    if (props.onScreen === null) {
      const one = player(e.requestId)
      if (one.timer) stop($, e.requestId)
      one.hasAutoplayed = true
    }
    const key = `${version}|${versions.get(e.requestId) ?? 0}|${e.viewport?.columns ?? 0}|${e.viewport?.rows ?? 0}`
    const kept = drawn.get(e.requestId)
    if (kept?.key === key) return kept.tree as Awaited<ReturnType<typeof Viewer>>
    const shown = parseShown(props.output)
    if (!shown) return next(e)
    const tree = await Viewer($, e, shown, e.requestId, false, e.viewport)
    drawn.set(e.requestId, { key, tree })

    return tree
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const shown = await read($, current)
    if (!shown) return <Text dimColor>Nothing to show yet. Run /img path/to/file</Text>

    return Viewer($, e, shown, PANE, true, e.viewport)
  })
}
