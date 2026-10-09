import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Check, Frames, KeyChange, Overlay, Shown, Summary } from '../types'

const PANE = 'show-your-work'
// The tools, and their names from before the rename, so old windows still draw.
const TOOLS = ['show_image', 'show_video'].flatMap(t => [`mcp__show-your-work__${t}`, `mcp__image-view__${t}`])
const TMP = '/tmp/claude-show-your-work'
const MARK = 'show-your-work:'
const OLD_MARK = 'image-view:'
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
const current = atom({ plugin: 'show-your-work', key: 'current' } as const, null)

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
  // which earlier version the compared side is, when there are several
  step?: number
  hasAutoplayed?: boolean
  // how many bar cells the scrub row last drew, so playback redraws only on a change
  segments?: number
  // which page of key changes the sidebar shows
  changesPage?: number
  // where the updated video was, kept while a still original is shown
  updatedFrame?: number
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
  // Some recordings (MediaRecorder webm) carry no duration: sample those at the
  // top rate. The clip's length is then what the frames cover.
  const probed = Number(probe.stdout.trim())
  const fps = sampleRate(Number.isFinite(probed) && probed > 0 ? probed : 1)
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
  const frames = { dir, count, fps, duration: count / fps }
  const poster = frameFile(frames, 0)

  return { kind: 'video', path: poster, source: real, ...(await pngSize($, poster)), title, generation, frames }
}

// A window from days ago whose frames were cleaned up cuts them again, once.
const recut = new Map<string, Promise<unknown>>()
function ensureFrames($: EngineInterface, media: Shown): Promise<unknown> {
  const f = media.frames
  if (!f || !media.source) return Promise.resolve()
  let job = recut.get(f.dir)
  if (!job) {
    job = $.fs.stat(frameFile(f, 0)).catch(async () => {
      await $.process.run(['mkdir', '-p', f.dir])
      await $.process.run([
        ffmpeg, '-v', 'error', '-i', media.source!, '-vf', `fps=${f.fps},scale='min(960,iw)':-2`,
        '-frames:v', String(f.count), '-compression_level', '1', `${f.dir}/f%05d.png`,
      ])
    }).catch(() => undefined)
    recut.set(f.dir, job)
  }
  return job
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

// Each frame as a 64×36 grey thumbnail, for matching the two runs by eye.
async function thumbs($: EngineInterface, f: Frames): Promise<number[][]> {
  const r = await $.process.run([
    'sh', '-c',
    `"$0" -v error -framerate ${f.fps} -i "$1/f%05d.png" -vf scale=64:36,format=gray -f rawvideo - | od -An -tu1 -v`,
    ffmpeg, f.dir,
  ])
  const px = r.stdout.trim().split(/\s+/).map(Number)
  const out: number[][] = []
  for (let i = 0; i + 2304 <= px.length; i += 2304) out.push(px.slice(i, i + 2304))
  return out
}

// What moved since the previous frame: the cursor, a fade, a scroll. The two
// runs move the same way even where the designs differ.
const motion = (f: number[][]) => f.map((px, i) => (i ? px.map((v, k) => v - f[i - 1]![k]!) : px.map(() => 0)))

// The cheapest way to walk both runs in order, frame by frame (dynamic time
// warping), matching how frames look and how they move: [updated, original]
// frame pairs. Holding one side still costs a little, so it only holds where
// the runs really differ.
export function align(a: number[][], b: number[][], hold = 0.01): [number, number][] {
  const n = a.length, m = b.length
  if (!n || !m) return []
  const ma = motion(a), mb = motion(b)
  const diff = (i: number, j: number) => {
    let d = 0, e = 0
    const pa = a[i]!, pb = b[j]!, qa = ma[i]!, qb = mb[j]!
    for (let k = 0; k < pa.length; k++) {
      d += Math.abs(pa[k]! - pb[k]!)
      e += Math.abs(qa[k]! - qb[k]!)
    }
    return (d + 4 * e) / (pa.length * 255)
  }
  const cost = new Float64Array(n * m)
  const step = new Uint8Array(n * m) // 0 both, 1 updated only, 2 original only
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = diff(i, j)
      if (!i && !j) { cost[0] = d; continue }
      const both = i && j ? cost[(i - 1) * m + j - 1]! : Infinity
      const up = i ? cost[(i - 1) * m + j]! + hold : Infinity
      const on = j ? cost[i * m + j - 1]! + hold : Infinity
      const best = Math.min(both, up, on)
      cost[i * m + j] = best + d
      step[i * m + j] = best === both ? 0 : best === up ? 1 : 2
    }
  }
  const path: [number, number][] = []
  for (let i = n - 1, j = m - 1; ; ) {
    path.push([i, j])
    if (!i && !j) break
    const s = step[i * m + j]
    if (s === 0) { i--; j-- } else if (s === 1) i--
    else j--
  }
  return path.reverse()
}

// For each updated frame, the original frame shown beside it.
export function matchOf(path: [number, number][], count: number): number[] {
  const out = new Array<number>(count).fill(0)
  for (const [i, j] of path) if (i < count) out[i] = j
  for (let i = 1; i < count; i++) out[i] = Math.max(out[i]!, out[i - 1]!)
  return out
}

// The path cut to the few turns that matter, in seconds, to keep it small.
export function turns(match: number[], fpsA: number, fpsB: number): [number, number][] {
  const points: [number, number][] = []
  for (let i = 1; i < match.length - 1; i++) {
    const before = match[i]! - match[i - 1]!, after = match[i + 1]! - match[i]!
    if ((before === 0) !== (after === 0) || Math.abs(before - after) > 1) points.push([+(i / fpsA).toFixed(2), +(match[i]! / fpsB).toFixed(2)])
  }
  return points.length > 40 ? points.filter((_, k) => k % Math.ceil(points.length / 40) === 0) : points
}

// Pixels between Original and Updated in the merged clip.
const PAIR_GAP = 40

// Merges the original and updated recordings into one clip, side by side.
// The original's frames are matched to the updated clip's by how they look,
// so every step happens at the same moment on both sides.
async function preparePair($: EngineInterface, original: Shown, updated: Shown) {
  const f = updated.frames!, g = original.frames!
  generation += 1
  const dir = `${TMP}/p${generation}-${Math.floor(await $.clock.now())}`
  await $.process.run(['mkdir', '-p', `${dir}/o`])
  const [ta, tb] = await Promise.all([thumbs($, f), thumbs($, g)])
  const match = ta.length && tb.length
    ? matchOf(align(ta, tb), f.count)
    : Array.from({ length: f.count }, (_, i) => Math.min(g.count - 1, Math.round(mapTime(anchors(updated.checks, original.checks), i / f.fps, f.duration, g.duration) * g.fps)))
  const links = match.map((j, i) => `ln -sf "$0/${frameFile(g, j).split('/').pop()}" "$1/o/f${String(i + 1).padStart(5, '0')}.png"`).join('\n')
  await $.process.run(['sh', '-c', links, g.dir, dir])
  const made = await $.process.run([
    ffmpeg, '-v', 'error', '-framerate', String(f.fps), '-i', `${dir}/o/f%05d.png`, '-framerate', String(f.fps), '-i', `${f.dir}/f%05d.png`,
    '-filter_complex', `[0:v]scale=-2:360,pad=iw+${PAIR_GAP}:ih:0:0:color=${SIDEBAR.replace('#', '0x')}[a];[1:v]scale=-2:360[b];[a][b]hstack=inputs=2`,
    '-frames:v', String(f.count), '-compression_level', '1', `${dir}/f%05d.png`,
  ])
  await $.process.run(['rm', '-rf', `${dir}/o`])
  if (made.exitCode !== 0) return null
  const count = (await $.fs.list(dir)).filter(x => x.name.endsWith('.png')).length
  if (!count) return null
  const size = await pngSize($, `${dir}/f00001.png`)

  return { pair: { dir, count, fps: f.fps, duration: f.duration }, pairWidth: size.width, pairHeight: size.height, sync: turns(match, f.fps, g.fps) }
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

// A time is only worth a click when it points somewhere: a picture has no
// timeline, and a clip where every change sits at the same second isn't
// pointing anywhere either. Those rows are plain text.
export function timesThatMean(changes: KeyChange[] | undefined, isVideo: boolean): KeyChange[] | undefined {
  if (!changes) return changes
  const times = new Set(changes.filter(c => c.at !== undefined).map(c => c.at))
  const isPointing = isVideo && (times.size > 1 || (times.size === 1 && changes.length === 1))

  return isPointing ? changes : changes.map(({ at: _, ...c }) => c)
}

// Every shown file is kept as it was then, so an old row keeps its picture
// when the file is overwritten, and showing the same path again after edits
// compares against the version before, with every earlier one a step away.
async function keepVersion($: EngineInterface, raw: string): Promise<{ real: string; copy: string; earlier: string[] }> {
  const real = (await $.fs.stat(expand(raw, cwd, home), { resolve: true })).realPath ?? expand(raw, cwd, home)
  const key = real.replace(/[^\w.-]/g, '_')
  generation += 1
  const copy = `${TMP}/kept/${key}~${generation}-${Math.floor(await $.clock.now())}${real.match(/\.[^./]+$/)?.[0] ?? ''}`
  const r = await $.process.run(['sh', '-c',
    'mkdir -p "${3%/*}"; last=$(ls -t "${3%/*}/$1~"* 2>/dev/null | head -1)\n' +
    'cp -c "$2" "$3" 2>/dev/null || cp "$2" "$3" || exit 1\n' +
    '[ -n "$last" ] && cmp -s "$last" "$3" && rm -f "$last"\n' +
    'ls -tr "${3%/*}/$1~"* | grep -vxF "$3"; true',
    'keep', key, real, copy])
  if (r.exitCode !== 0) return { real, copy: real, earlier: [] }

  return { real, copy, earlier: r.stdout.split('\n').filter(Boolean) }
}

// The tool's text result carries the shown item as `show-your-work:{json}`;
// the output may be that string or a list of text blocks.
export function parseShown(output: unknown): Shown | null {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? output.map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n')
        : ''
  const line = text.split('\n').find(l => l.startsWith(MARK) || l.startsWith(OLD_MARK))
  if (!line) return null
  try {
    return JSON.parse(line.slice(line.indexOf(':') + 1)) as Shown
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
  if (count > 1 && frame >= count - 1) return '↺ Replay'

  return frame > 0 ? '▶ Resume' : '▶ Play'
}

const sideOf = (shown: Shown, site: string): Shown =>
  player(site).isCompare && shown.compare ? shown.compare : shown

const plainAt = (media: Shown, frame: number) =>
  media.frames ? frameFile(media.frames, Math.min(frame, media.frames.count - 1)) : media.path


// The same moment on the other clip: updated → original seconds, and back.
const toOriginal = (shown: Shown, t: number) =>
  shown.frames && shown.compare?.frames
    ? mapTime(shown.sync ?? anchors(shown.checks, shown.compare.checks), t, shown.frames.duration, shown.compare.frames.duration)
    : t
const toUpdated = (shown: Shown, t: number) =>
  shown.frames && shown.compare?.frames
    ? mapTime((shown.sync ?? anchors(shown.checks, shown.compare.checks)).map(([a, b]) => [b, a] as [number, number]), t, shown.compare.frames.duration, shown.frames.duration)
    : t

// The compared side's frame at the moment the shown side is at.
const compareFrame = (shown: Shown, frame: number) => {
  const a = shown.frames, b = shown.compare?.frames
  if (!a || !b) return 0
  const t = mapTime(shown.sync ?? anchors(shown.checks, shown.compare?.checks), frame / a.fps, a.duration, b.duration)
  return Math.max(0, Math.min(b.count - 1, Math.round(t * b.fps)))
}

type Source = { png: string } | { file: string; format: 'png' }

// Bytes when the file reads; its path as a last resort.
// The terminal reads the file itself: a path crosses, not the picture. Sending
// bytes (b6b8b14) moved ~400 KB a frame and froze playback.
export function pngSource(_$: EngineInterface, file: string): Promise<Source> {
  return Promise.resolve({ file, format: 'png' as const })
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

async function blit($: EngineInterface, site: string, key: string, media: Shown, file: string, frame: number) {
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
  const differing = (shown.checks ?? []).filter(c => c.at !== undefined && before.has(c.name) && before.get(c.name) !== c.ok && c.at <= seconds)
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
  if (one.frame >= frames.count - 1) {
    one.frame = 0
    draw($, site, media, shown)
  }
  // The picture swaps every frame; the bar and the time redraw once a second,
  // or when the change on screen moves on. A redraw repaints every player
  // window in the chat, so it stays rare.
  const timed = inClipOrder(shown?.changes ?? [])
  const isOriginal = !!shown && media !== shown
  const marks = () => {
    const t = one.frame / frames.fps
    return `${Math.floor(t)}|${liveChange(timed, shown && isOriginal ? toUpdated(shown, t) : t, frames.fps)}`
  }
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
  // Beside a still picture there's no moment to match: keep the video's place.
  if (toCompare) {
    one.updatedFrame = one.frame
    one.frame = compareFrame(shown, one.frame)
  } else if (from.frames && to.frames) {
    const t = toUpdated(shown, one.frame / from.frames.fps)
    one.frame = Math.max(0, Math.min(to.frames.count - 1, Math.round(t * to.frames.fps)))
  } else one.frame = one.updatedFrame ?? 0
  draw($, site, to)
  if (wasPlaying && to.frames) play($, site, to, shown)
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
  if (one.isCompare && shown.compare.frames && shown.frames)
    one.frame = Math.max(0, Math.min(shown.frames.count - 1, Math.round(toUpdated(shown, one.frame / shown.compare.frames.fps) * shown.frames.fps)))
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
  const elapsed = clock(one.frame >= frames.count - 1 ? frames.duration : one.frame / frames.fps)
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
          onPress={() => seek($, site, media, (Math.round((c.start / Math.max(1, segments - 1)) * (frames.count - 1)) + 0.5) / frames.fps, shown)}
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
// The compared side when it is one of several earlier versions: the one
// before by default, with ‹ › to step further back. Versions are numbered
// from the first one shown, so the updated side is the highest.
export function atStep(shown: Shown, site: string): Shown {
  const step = player(site).step
  const picked = step === undefined ? undefined : prepared.get(shown.history?.[step] ?? '')
  return picked ? { ...shown, compare: picked } : shown
}

// Kept copies never change, so each is read once, when first stepped to.
const prepared = new Map<string, Shown>()
async function preparedOf($: EngineInterface, path: string): Promise<Shown> {
  const known = prepared.get(path)
  if (known) return known
  const made = await prepare($, path, 'Original')
  remember(path, made)
  return made
}
// Entries are a path and a size, not pixels; the oldest go past 200.
function remember(path: string, made: Shown) {
  prepared.set(path, made)
  if (prepared.size > 200) prepared.delete(prepared.keys().next().value!)
}

function Steps(ui: Ui, $: EngineInterface, site: string, shown: Shown) {
  const { Box, Button, Text } = ui
  const history = shown.history!
  const one = player(site)
  const at = one.step ?? history.length - 1
  const go = (to: number) => () => {
    if (to < 0 || to >= history.length) return
    void preparedOf($, history[to]).then(version => {
      one.step = to
      if (one.isSplit) split($, site, shown, false)
      if (!one.isCompare) flip($, site, { ...shown, compare: version }, true)
      else draw($, site, version)
      redraw($, site)
    }).catch(() => $.ui.toast('That version is gone'))
  }

  return (
    <Box key="steps" flexDirection="row" gap={1}>
      <Button key="step-back" plain dimColor={at === 0} label="‹ older" onPress={go(at - 1)} />
      <Text dimColor>{`${shown.compare?.label ?? 'Original'} is version ${at + 1} of ${history.length + 1}`}</Text>
      <Button key="step-on" plain dimColor={at === history.length - 1} label="newer ›" onPress={go(at + 1)} />
    </Box>
  )
}

function Tabs(ui: Ui, $: EngineInterface, site: string, shown: Shown) {
  const { Box, Button } = ui
  if (!shown.compare) return null
  const one = player(site)
  const isBoth = !!one.isSplit
  const isCompare = !isBoth && !!one.isCompare
  const isUpdated = !isBoth && !isCompare
  const canBoth = !!(shown.frames && shown.pair)
  const hasSteps = (shown.history?.length ?? 0) > 1
  const pick = (toCompare: boolean) => () => {
    if (isBoth) split($, site, shown, false)
    flip($, site, shown, toCompare)
  }

  return (
    <Box flexDirection="column">
      <Box key="sides" flexDirection="row" gap={1}>
        <Button key="side-before" variant={isCompare ? 'primary' : 'secondary'} label={shown.compare.label ?? 'Original'} onPress={pick(true)} />
        <Button key="side-after" variant={isUpdated ? 'primary' : 'secondary'} label={shown.label ?? 'Updated'} onPress={pick(false)} />
        {canBoth && <Button key="side-both" variant={isBoth ? 'primary' : 'secondary'} label="⧉ Both" onPress={() => split($, site, shown, !isBoth)} />}
      </Box>
      {hasSteps && Steps(ui, $, site, shown)}
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
// The sidebar's top bar, a step lighter than the sidebar.
const TOPBAR = '#272930'
// Room for a change's title and a QA line, in a column this wide.
const titleWidth = (column: number) => column - 4 /* "12. " */ - 1 - 6 /* " 0:07 " */
const labelWidth = (column: number) => column - 4 /* card border + padding */ - 2 /* "✓ " */ - 5 /* " 11/11" */
// Under the player, what changed and the QA sit side by side from this width.
const TWO_COLUMNS = 72

// Rows the sidebar spends on everything but the change rows.
export function changesThatFit(height: number, summaryRows: number, hasPr: boolean, hasCompare: boolean, hasSteps = false) {
  const qa = summaryRows >= 0 ? 1 /* gap */ + 1 /* label */ + 2 /* card border */ + 1 /* verdict */ + summaryRows : 0
  const fixed = 2 /* padding */ + (hasCompare ? (hasSteps ? 4 : 3) : 0) /* top bar, with the version line */ + 1 /* label */ + qa + (hasPr ? 2 : 0)
  return Math.max(1, height - fixed)
}

// The change on screen now: the last one whose moment has come, allowing for
// a seek landing up to half a frame early.
export function liveChange(changes: KeyChange[], now: number, fps: number): number {
  return changes.reduce((hit, c, i) => (c.at !== undefined && c.at <= now + 0.5 / fps ? i : hit), -1)
}

// Changes in the order they show in the clip; ones without a time keep
// their place after the timed ones.
export function inClipOrder(changes: KeyChange[]): KeyChange[] {
  return changes.map((c, i) => ({ c, i })).sort((a, b) => (a.c.at ?? Infinity) - (b.c.at ?? Infinity) || a.i - b.i).map(x => x.c)
}

// Words wrapped to lines of at most width, so the whole text is always shown.
export function wrapWords(text: string, width: number): string[] {
  width = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w; ) {
      const piece = w.length > width ? w.slice(0, width) : w
      w = w.slice(piece.length)
      if (!line) line = piece
      else if (line.length + 1 + piece.length <= width) line += ' ' + piece
      else {
        lines.push(line)
        line = piece
      }
    }
  }
  return lines.length || line ? [...lines, line].filter(Boolean) : ['']
}

// Splits wrapped items into pages that each fit rows; an item never splits.
export function pagesOf<T>(items: { item: T; rows: number }[], rows: number): T[][] {
  const pages: T[][] = [[]]
  let used = 0
  for (const { item, rows: need } of items) {
    if (used + need > rows && pages.at(-1)!.length) {
      pages.push([])
      used = 0
    }
    pages.at(-1)!.push(item)
    used += need
  }
  return pages
}

// The report: the Original / Updated / Both switch in a top bar, what changed
// (each one jumps to its moment; the one playing now is lit), the QA in a
// card, then the PR. Text wraps; nothing is cut. Beside the player it is a
// sidebar exactly as tall as the player, paging what doesn't fit; under it (a
// narrow window) it spans the player's width, in two columns when there's room.
function Report(ui: Ui, $: EngineInterface, site: string, shown: Shown, prLink: Ui, at: { width: number; height?: number }) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const { width, height } = at
  const isBeside = height !== undefined
  const isTwo = !isBeside && width - 4 >= TWO_COLUMNS
  const column = isTwo ? Math.floor((width - 4 - 3) / 2) : width - 4
  const TITLE = titleWidth(column), LABEL = labelWidth(column)
  const changes = inClipOrder(shown.changes?.length ? shown.changes : shown.change ? [{ title: shown.change }] : [])
  // The summary is the updated side's; on the original, its own checks count.
  const summary = (media === shown ? shown.summary ?? [] : []).slice(0, 3).map(s => ({ ...s, lines: wrapWords(s.label, LABEL) }))
  const { passed, total } = qaTotals(summary, media.checks)
  const allPass = total > 0 && passed === total
  const summaryRows = summary.reduce((n, s) => n + s.lines.length, 0)
  const room = isBeside ? changesThatFit(height, total > 0 ? summaryRows : -1, !!prLink, !!shown.compare, (shown.history?.length ?? 0) > 1) : Infinity
  const wrapped = changes.map((c, n) => ({ c, n, lines: wrapWords(c.title, TITLE) }))
  const pages = pagesOf(wrapped.map((w, i) => ({ item: w, rows: w.lines.length + (i ? 1 : 0) })), room)
  const page = Math.min(one.changesPage ?? 0, pages.length - 1)
  // Changes are timed on the updated clip; on the original, map the clock.
  const onOriginal = media !== shown
  const now = media.frames ? (onOriginal ? toUpdated(shown, one.frame / media.frames.fps) : one.frame / media.frames.fps) : -1
  const live = liveChange(changes, now, media.frames?.fps ?? 12)
  const label = (text: string, right?: Ui) => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor bold>{text}</Text>
      {right}
    </Box>
  )

  const changed = (
    <Box flexDirection="column" width={column}>
      {label(
        `WHAT CHANGED · ${changes.length}`,
        pages.length > 1 ? (
          <Button
            key="changes-more"
            plain
            dimColor
            label={`${page + 1}/${pages.length} ↓`}
            onPress={() => {
              one.changesPage = (page + 1) % pages.length
              redraw($, site)
            }}
          />
        ) : undefined,
      )}
      {(pages[page] ?? []).map(({ c, n, lines }, k) => {
        const isLive = n === live
        const jump = () => c.at !== undefined && seek($, site, media, onOriginal ? toOriginal(shown, c.at) : c.at, shown)
        return (
          <Box key={`change-${n}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isLive ? 'suggestion' : undefined} dimColor={!isLive}>{`${n + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={TITLE}>
              {lines.map((line, i) =>
                c.at !== undefined
                  ? <Button key={`change-${n}-${i}`} plain label={line} onPress={jump} />
                  : <Text key={`change-${n}-${i}`}>{line}</Text>,
              )}
            </Box>
            {c.at !== undefined && (
              <Text backgroundColor={isLive ? 'suggestion' : PILL} color={isLive ? 'inverseText' : undefined}>
                {` ${clock(c.at)} `}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
  const qa = total > 0 && (
    <Box flexDirection="column" width={column} marginTop={isTwo ? 0 : 1}>
      {label('QA', <Text bold color={allPass ? 'success' : 'error'}>{passed}/{total}</Text>)}
      <Box flexDirection="column" borderStyle="round" borderColor={allPass ? 'success' : 'error'} borderDimColor paddingX={1}>
        <Text bold color={allPass ? 'success' : 'error'}>
          {allPass ? '✓ All checks passed' : `✗ ${total - passed} of ${total} checks failed`}
        </Text>
        {summary.map(s => (
          <Box key={`sum-${s.label}`} flexDirection="row" gap={1}>
            <Text color={s.ok ? 'success' : 'error'}>{s.ok ? '✓' : '✗'}</Text>
            <Box flexDirection="column" width={LABEL}>
              {s.lines.map((line, i) => <Text key={`sum-${s.label}-${i}`}>{line}</Text>)}
            </Box>
            {s.total !== undefined && <Text dimColor>{`${s.passed ?? (s.ok ? s.total : 0)}/${s.total}`.padStart(5)}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" backgroundColor={SIDEBAR}>
      {shown.compare && (
        <Box width={width} backgroundColor={TOPBAR} paddingX={2} paddingY={1}>
          {Tabs(ui, $, site, shown)}
        </Box>
      )}
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {changes.length > 0 && (isTwo ? <Box flexDirection="row" gap={3}>{changed}{qa}</Box> : changed)}
        {(!isTwo || !changes.length) && qa}
        {prLink && <Box flexDirection="row" gap={1} marginTop={1}><Text dimColor>PR</Text>{prLink}</Box>}
      </Box>
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
    // A free name: "clip.mp4", then "clip 2.mp4", "clip 3.mp4"…
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let out = `${home}/Downloads/${name}`
    for (let n = 2; await $.fs.stat(out).then(() => true, () => false); n++) out = `${home}/Downloads/${stem} ${n}${ext}`
    const r = await $.process.run(['cp', source, out])
    if (r.exitCode === 0) await $.process.run(['open', '-R', out])
    done(r, `Saved to Downloads/${out.split('/').pop()}`)
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
  const source = media.origin ?? media.source ?? media.path
  const columns = viewport?.columns ?? 100
  const hasReport = !!(shown.change || shown.changes?.length || shown.summary?.length || shown.checks?.length)
  const isWide = hasReport && columns - 8 >= WIDE_ENOUGH
  const room = columns - (isPane ? 6 : 10) - (isWide ? SIDE + 3 : 0)
  const box = sizeFor(media.width, media.height, room, viewport?.rows ?? 40, isPane)
  const isNarrow = box.columns < 60
  // Under the player the report takes at least a readable width, even beside a tall, thin picture.
  const below = hasReport && !isWide ? Math.max(box.columns, Math.min(columns - (isPane ? 6 : 10), 72)) : box.columns
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
  await ensureFrames($, media)
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
          {!isWide && !hasReport && Tabs(ui, $, site, shown)}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {opener}
          {actions}
        </Box>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={(isWide ? box.columns + SIDE + 3 : Math.max(box.columns, below)) + 4}>
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
      {!hasReport && prLink && (
        <Box flexDirection="row" gap={2}>
          {prLink}
          {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
        </Box>
      )}
      <Box flexDirection="row" gap={3} marginTop={1}>
        {stage}
        {isWide && Report(ui, $, site, shown, prLink, { width: SIDE, height: box.rows + (frames ? 3 : 2) })}
      </Box>
      {!isWide && hasReport && <Box marginTop={1}>{Report(ui, $, site, shown, prLink, { width: below })}</Box>}
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
  // The Updated side starts past the Original side and the gap between them.
  const pairPx = shown.pairWidth ?? shown.width * 2
  const half = Math.round((width * ((pairPx - PAIR_GAP) / 2 + PAIR_GAP)) / pairPx)
  const seconds = one.frame / shown.frames!.fps
  const change = changeAt(shown, seconds)
  const { fixed, broken } = checkDiff(shown.checks, before.checks)
  one.box = { columns: box.columns, rows: box.rows }
  const pic = await picFor($, frameFile(pair, Math.min(one.frame, pair.count - 1)), box)
  probe($, site, 'view-pair', pic)
  const head = (s: Shown, fallback: string, w: number) => {
    const words = resultWords(s.checks)
    const ok = (s.checks ?? []).every(c => c.ok)
    return (
      <Box width={w} flexDirection="row" gap={1}>
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
        {head(before, 'Original', half)}
        {head(shown, 'Updated', width - half)}
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
  description: 'The key changes to review: each { title (a few words), detail?, at? (seconds into the clip where it shows), url? }. They are listed in clip order.',
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
    label: { type: 'string', description: 'Name of this side when comparing. Leave unset so it reads "Updated"; set it only when the user asks for other names' },
    compare_label: { type: 'string', description: 'Name of the compared side. Leave unset so it reads "Original"; set it only when the user asks for other names' },
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
    const env = await $.process.run(['sh', '-lc', 'echo "home=$HOME"; echo "ff=$(command -v ffmpeg)"; echo "fp=$(command -v ffprobe)"'])
    const got = (key: string) => env.stdout.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? ''
    const ff = got('ff'), fp = got('fp')
    home = got('home')
    ffmpeg = ff || '/opt/homebrew/bin/ffmpeg'
    ffprobe = fp || '/opt/homebrew/bin/ffprobe'
    // Frames and converted pictures a week old go; a window that scrolls back
    // into view cuts its frames again from the source.
    void $.process.run(['sh', '-c', `find ${TMP} -mindepth 1 -maxdepth 1 ! -name kept -mtime +7 -exec rm -rf {} + 2>/dev/null; find ${TMP}/kept -type f -mtime +7 -delete 2>/dev/null; true`])
    await $.command.register({
      name: 'img',
      description: 'Show an image or video in a pane: /img <path>',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        "Show a local image (PNG, JPEG, WebP, GIF, TIFF) inline in the user's terminal. " +
        "Use it unasked whenever you've made visual work the user should see: a rendered page or slide, a chart, a mockup. " +
        'Whenever it shows work you changed, ALWAYS pass `changes` (what you changed, a few words each) and `summary` (the QA in up to 3 lines, ' +
        'each with ok, passed and total), plus `compare` (the before file) when you have one and `url` for a page: they fill the sidebar the user ' +
        'reviews with (what changed, QA, Original/Updated/Both). Without them the user gets a bare picture. Keep it to what really changed: a small edit is one change, and leave out `summary` if you ran no real checks; never pad either list. ' +
        'Showing the same path again after changing it compares against the version shown before on its own (the user can step back through older ones), so re-render to the same file; pass `compare` to pick a different before. ' +
        'The user sees the picture and you do not get it back, so Read the image only when you must check it yourself.',
      inputSchema: TOOL_INPUT,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_video',
      description:
        "Play a local video (MP4, MOV, WebM, GIF) inline in the user's terminal in a player that starts by itself. " +
        'Use it to show recordings you made: a Playwright run clicking through and checking a page, a rendered animation or film cut. ' +
        'Whenever it shows work you changed, ALWAYS pass `changes` (what you changed, each with `at` = the second it shows in the clip), ' +
        '`summary` (the QA in up to 3 lines, each with ok, passed and total), and `compare` (the before recording of the same flow, same script) ' +
        'with `checks`/`compare_checks` (each with `at`) when you ran them, plus `url` for the page: they fill the sidebar the user reviews with ' +
        '(what changed, QA, Original/Updated/Both, synced side by side). Without them the user gets a bare player. Keep it to what really changed: a small edit is one change, and leave out `summary` if you ran no real checks; never pad either list. ' +
        'Showing the same path again after changing it compares against the version shown before on its own (the user can step back through older ones), so re-render to the same file; pass `compare` to pick a different before. ' +
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

  on('tool.call', { tool: /^mcp__(show-your-work|image-view)__show_(image|video)$/ }, async ($, e) => {
    freshCalls.add(e.tool_use_id)
    const input = e as unknown as {
      path?: string; title?: string; change?: string; pr?: string; changes?: KeyChange[]; summary?: Summary[]; url?: string; checks?: Check[]
      compare?: string; compare_checks?: Check[]; label?: string; compare_label?: string; overlay?: Overlay
    }
    if (!input.path) return { deny: 'A path is needed.' }
    try {
      const kept = await keepVersion($, input.path).catch(() => ({ real: input.path!, copy: input.path!, earlier: [] as string[] }))
      const compare = input.compare ?? kept.earlier.at(-1)
      const shown: Shown = {
        ...(await prepare($, kept.copy, input.title ?? input.path.split('/').pop())),
        origin: kept.real,
        change: input.change,
        pr: input.pr,
        url: input.url,
        checks: input.checks,
        changes: timesThatMean(input.changes, VIDEO.test(input.path)),
        summary: input.summary,
        label: input.label,
        overlay: input.overlay,
      }
      if (compare) {
        const label = input.compare_label
        shown.compare = {
          ...(input.compare ? await prepare($, compare, label ?? 'Original') : await preparedOf($, compare)),
          label,
          checks: input.compare_checks,
        }
        // A picture can step back through every earlier version; a clip
        // compares with the one before only, as each needs its frames cut.
        if (!input.compare && !shown.frames && kept.earlier.length > 1) {
          shown.history = kept.earlier
        }
        if (shown.frames && shown.compare.frames) Object.assign(shown, (await preparePair($, shown.compare, shown)) ?? {})
      }
      if (!shown.frames && kept.copy !== kept.real)
        remember(kept.copy, { kind: shown.kind, path: shown.path, source: shown.source, width: shown.width, height: shown.height, title: 'Original', generation: shown.generation })
      const what = shown.frames ? `video, ${clock(shown.frames.duration)}` : `${shown.width}×${shown.height}`

      return { result: `Shown to the user: ${shown.title} (${what}).\n${MARK}${JSON.stringify(shown)}` }
    } catch (err) {
      return { deny: `show-your-work: ${(err as Error).message}` }
    }
  }).catch(() => ({ deny: 'show-your-work: it could not be shown.' }))

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
    const tree = await Viewer($, e, atStep(shown, e.requestId), e.requestId, false, e.viewport)
    drawn.set(e.requestId, { key, tree })

    return tree
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const shown = await read($, current)
    if (!shown) return <Text dimColor>Nothing to show yet. Run /img path/to/file</Text>

    return Viewer($, e, atStep(shown, PANE), PANE, true, e.viewport)
  })
}
