import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Check, Frames, KeyChange, Overlay, Shown, Summary } from '../types'

const PANE = 'show-your-work'
// The tools, and their names from before the rename, so old windows still draw.
const TOOLS = ['show_image', 'show_video'].map(t => `mcp__show-your-work__${t}`)
// Frames and converted pictures. A private folder per user, chosen at session
// start: a fixed name in the shared /tmp could be made first, or pointed
// elsewhere, by another user on the same machine.
let TMP = '/tmp/claude-show-your-work'
export const PICK_TMP = [
  'base="${TMPDIR:-/tmp}"; base="${base%/}"; d="$base/claude-show-your-work-$(id -u)"',
  'mkdir -m 700 -p "$d" 2>/dev/null',
  'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then chmod 700 "$d"; printf "%s" "$d"; else mktemp -d "$base/claude-show-your-work-XXXXXX"; fi',
].join('\n')
// Deletes the oldest frame folders until the cache is under $1 KB, keeping the
// newest two and the ones named in $2; only inside a folder this user owns.
export const TRIM_SH = [
  '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] && cd -P "$0" 2>/dev/null || exit 0',
  // Only the folders the plugin names (v-<key>, v<n>-<time>, p-<key>,
  // p2-<key>), one per line: a picture named by the user never matches.
  'all=$(ls -dtr -- v* p* 2>/dev/null | grep -E "^(v-[0-9a-f]+|v[0-9]+-[0-9]+|p2?-[0-9a-f]+)$"); n=$(printf "%s\\n" "$all" | grep -c .)',
  'printf "%s\\n" "$all" | head -n $((n > 2 ? n - 2 : 0)) | while IFS= read -r d; do',
  '  [ -n "$d" ] && [ -d "$d" ] || continue',
  '  [ "$(du -sk . | cut -f1)" -le "$1" ] && break',
  '  case " $2 " in *" $d "*) continue ;; esac',
  '  [ -L "$d" ] || rm -rf "./$d"',
  'done; true',
].join('\n')
// Deletes anything in the cache older than a week, without following links.
export const CLEAN_SH = [
  '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] || exit 0',
  'find -P "$0" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null; true',
].join('\n')
const MARK = 'show-your-work:'
// Screenshots and recordings made only to be shown go to the temp folder, so
// they don't pile up in the project; the history keeps its own copy.
const SCRATCH_NOTE = 'Save screenshots and recordings you make to show here in a temporary folder, such as $TMPDIR or /tmp, not in the project. Save them in the project only when the user asks to keep them, or when the project already has a folder for them, such as one for test screenshots.'
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i
// What can be shown at all: anything else is refused before it is copied.
const MEDIA = /\.(png|jpe?g|webp|gif|tiff?|heic|heif|bmp|avif|mp4|mov|m4v|webm|mkv|avi)$/i
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

// Where things are: the temp folder, home, ffmpeg and the cell's size. Run at
// session start, and by anything that needs it before then, since a reload
// mid-session can bring the module back without a session start.
let setup: Promise<void> | null = null
// Whether a Button can hold coloured Text (Claude Code 2.1.295 and later).
let canColourButtons = false
export const isAtLeast = (version: string, least: string) => {
  const [a, b] = [version, least].map(v => v.split(/[.-]/).slice(0, 3).map(Number))
  for (let i = 0; i < 3; i++) if ((a![i] ?? 0) !== (b![i] ?? 0)) return (a![i] ?? 0) > (b![i] ?? 0)
  return true
}
function setUp($: EngineInterface): Promise<void> {
  // Each step on its own: one that fails leaves the defaults, never a throw.
  const tryRun = (argv: string[], options?: { timeoutMs: number }) => Promise.resolve().then(() => $.process.run(argv, options)).catch(() => null)
  return (setup ??= (async () => {
    if (!cwd) cwd = ((await tryRun(['pwd']))?.stdout ?? '').trim()
    const picked = await tryRun(['sh', '-c', PICK_TMP])
    if (picked && picked.exitCode === 0 && picked.stdout.trim().startsWith('/')) TMP = picked.stdout.trim()
    // A login shell finds ffmpeg where the person's profile puts it; one that
    // hangs gets five seconds, then a plain shell and the usual places.
    const where = 'echo "home=$HOME"; echo "ff=$(command -v ffmpeg)"; echo "fp=$(command -v ffprobe)"; echo "os=$(uname -s)"'
    const run = (flag: string) => tryRun(['sh', flag, where], { timeoutMs: 5000 })
    const login = await run('-lc')
    const env = (login && login.stdout.includes('os=') ? login : await run('-c')) ?? { stdout: '', stderr: '', exitCode: 1 }
    const got = (key: string) => env.stdout.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? ''
    home = got('home') || ((await Promise.resolve().then(() => $.env.get('HOME')).catch(() => '')) ?? '')
    isMac = got('os') !== 'Linux'
    ffmpeg = got('ff') || (isMac ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg')
    ffprobe = got('fp') || (isMac ? '/opt/homebrew/bin/ffprobe' : '/usr/bin/ffprobe')
    hasVideoTools = false
    // Over ssh the terminal can't read this machine's files: pictures go as bytes.
    const sshConnection = await Promise.resolve().then(() => $.env.get('SSH_CONNECTION')).catch(() => undefined)
    const sshTty = await Promise.resolve().then(() => $.env.get('SSH_TTY')).catch(() => undefined)
    if (sshConnection || sshTty) sendBytes = true
    const engine = await Promise.resolve().then(() => $.session.version()).catch(() => null)
    canColourButtons = !!engine && isAtLeast(engine.base ?? engine.version, '2.1.295')
    await Promise.resolve().then(() => measureCells($)).catch(() => undefined)
  })())
}
let generation = 0
let pastedNames: string[] = []
// A button press, by name only. False, so it chains: act('save') || keep().
const act = (action: string): false => (track('action', { action }), false)

// Playback per drawn site (a transcript row's tool_use_id, or the pane).
type Player = {
  frame: number
  timer?: Timer
  isCompare?: boolean
  isSplit?: boolean
  // which earlier version the compared side is, when there are several
  step?: number
  // the sidebar lists the versions instead of what changed
  isHistory?: boolean
  // scrolled out of view since it was last drawn
  wasAway?: boolean
  // back in view: send the frame on screen again after drawing
  resend?: boolean
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
// Each failed show's notice, by tool call, for the box drawn in its place.
const notices = new Map<string, Notice>()
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
export const player = (site: string): Player => {
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

// A name with its look-alike spaces made plain: macOS writes a narrow
// no-break space before AM/PM in screenshot names, which a typed path lacks.
export const looseName = (name: string) =>
  name.normalize('NFC').replace(/[  -   　]/g, ' ')

// The file a path means: as given when it exists, else the one entry in its
// folder whose name matches once spaces are made plain.
async function locate($: EngineInterface, raw: string): Promise<string> {
  const path = expand(raw, cwd, home)
  if (await $.fs.stat(path).then(() => true, () => false)) return path
  const cut = path.lastIndexOf('/')
  const dir = path.slice(0, cut) || '/'
  const want = looseName(path.slice(cut + 1))
  const hit = (await $.fs.list(dir).catch(() => [])).find(f => looseName(f.name) === want)

  return hit ? `${dir.replace(/\/$/, '')}/${hit.name}` : path
}

export const frameFile = (frames: Frames, i: number) => `${frames.dir}/f${String(i + 1).padStart(5, '0')}.png`

// How fast to sample a clip so it stays under MAX_FRAMES.
export const sampleRate = (duration: number) =>
  Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / Math.max(duration, 0.1))))

export const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`

// macOS unless the session says Linux: every Linux path below is a branch
// beside the macOS one, which stays as it was.
let isMac = true
// Opens a file or URL with the desktop's default app.
const openCommand = () => (isMac ? 'open' : 'xdg-open')

// A PNG's size from its header (bytes 16 to 24), without any tool.
export function pngDims(base64: string): { width: number; height: number } | null {
  const b = Uint8Array.from(atob(base64.slice(0, 44)), c => c.charCodeAt(0))
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  const at = (i: number) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0

  return { width: at(16), height: at(20) }
}

// Finds a pasted image's original file by name with Spotlight (macOS).
async function findPasted($: EngineInterface, name: string): Promise<string | null> {
  if (name.startsWith('/')) return name
  if (!isMac) return null
  const found = await $.process.run(['mdfind', '-name', name])

  return found.stdout.split('\n').find(line => line.endsWith(`/${name}`)) ?? null
}

async function pngSize($: EngineInterface, png: string) {
  if (!isMac) {
    const d = pngDims(String((await $.fs.read(png, { as: 'bytes' }) as unknown as { base64: string }).base64 ?? ''))
    if (!d || !d.width || !d.height) throw new Error(`not an image: ${png}`)
    return d
  }
  const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png])
  const width = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  if (!width || !height) throw new Error(`not an image: ${png}`)

  return { width, height }
}

// Frames on disk are a cache: past 500 MB the oldest folders go, and a window
// that plays one again decodes it again (ensureChunk). The newest two stay.
const FRAMES_CAP_KB = 500_000
// Folders this session is playing are never trimmed.
function trimFrames($: EngineInterface) {
  const inUse = [...watching.keys()].map(d => d.split('/').pop()!).join(' ')
  return $.process.run(['sh', '-c', TRIM_SH, TMP, String(FRAMES_CAP_KB), inUse]).catch(() => undefined)
}

// A recording often opens on a blank page while the browser loads: white,
// off-white, grey or dark, maybe with a small spinner or logo. Any frame that
// is nearly one flat tone counts as blank; the clip starts at the first real one.
async function whiteLead($: EngineInterface, real: string, duration: number): Promise<number> {
  const r = await $.process.run([ffmpeg, '-v', 'info', '-t', '8', '-i', real,
    '-vf', 'fps=10,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YLOW:key=lavfi.signalstats.YHIGH',
    '-an', '-f', 'null', '-']).catch(() => null)
  return r ? leadFrom(r.stderr, duration) : 0
}

// The blank opening in that log: the time of the first frame whose 10th to
// 90th percentile brightness spreads wider than a flat page does, if that
// leaves something after it.
export function leadFrom(log: string, duration: number): number {
  let t = 0, low = -1
  for (const line of log.split('\n')) {
    const pts = line.match(/pts_time:([\d.]+)/)
    if (pts) { t = Number(pts[1]); low = -1; continue }
    const lo = line.match(/YLOW=([\d.]+)/)
    if (lo) { low = Number(lo[1]); continue }
    const hi = line.match(/YHIGH=([\d.]+)/)
    if (hi && low >= 0) {
      if (Number(hi[1]) - low > 24) {
        const lead = Math.round(t * 100) / 100
        return lead > 0 && (!(duration > 0) || lead < duration - 0.5) ? lead : 0
      }
      low = -1
    }
  }
  return 0
}

// Times given on the clip as it was, moved to the frames that start after
// its white opening.
export function shiftTimes<T extends { at?: number }>(list: T[] | undefined, lead: number): T[] | undefined {
  if (!list || !lead) return list
  return list.map(c => (c.at === undefined ? c : { ...c, at: Math.max(0, +(c.at - lead).toFixed(2)) }))
}

// Found once, then trusted for the session; while missing it is looked for
// again on each video, so installing it mid-session works.
let hasVideoTools = false

// What to tell Claude and the person when a video can't be cut into frames.
export const NO_FFMPEG =
  "videos need ffmpeg, and it isn't installed. Pictures still work. Install it with `brew install ffmpeg` " +
  '(Claude can run that for you), then restart Claude Code. No Homebrew? Install it first from https://brew.sh.'

// On Linux ffmpeg also turns pictures other than PNG into PNG.
export const NO_FFMPEG_LINUX =
  "videos and pictures other than PNG need ffmpeg, and it isn't installed. Install it with your package manager, " +
  'for example `sudo apt install ffmpeg` or `sudo dnf install ffmpeg` (Claude can run that for you), then restart Claude Code.'
export const noFfmpeg = (mac: boolean) => (mac ? NO_FFMPEG : NO_FFMPEG_LINUX)
export const FFMPEG_PROMPT_LINUX =
  "Install ffmpeg for me with this machine's package manager (for example `sudo apt install ffmpeg`). Then show it again."

// What the person pastes back so Claude installs ffmpeg and tries again.
export const FFMPEG_PROMPT =
  'Install ffmpeg for me with `brew install ffmpeg`. If Homebrew isn\'t installed, tell me how to install it first. Then show the video again.'

// A failure as the person and Claude see it: a box in place of the picture,
// one plain message for Claude, and a prompt to paste back. Never raw tool
// output, never the plugin's internal copy of a file.
export type NoticeKind = 'missing' | 'not_image' | 'broken_video' | 'no_picture' | 'no_ffmpeg' | 'other'
export type Notice = { kind: NoticeKind; title: string; text: string; message: string; prompt: string }

// How a failure reads, from whatever the tools said; `path` is the person's own.
export function noticeOf(err: unknown, path: string, homeDir = ''): Notice {
  const raw = String((err as Error)?.message ?? err)
  const shown = homeDir && path.startsWith(homeDir + '/') ? '~' + path.slice(homeDir.length) : path
  const name = path.split('/').pop() || path
  if (raw.includes(NO_FFMPEG_LINUX)) return {
    kind: 'no_ffmpeg', title: 'This needs ffmpeg', message: NO_FFMPEG_LINUX, prompt: FFMPEG_PROMPT_LINUX,
    text: "ffmpeg isn't installed, so videos and pictures other than PNG can't show here. Copy the prompt and paste it to Claude to install it, or install it yourself, for example `sudo apt install ffmpeg`.",
  }
  if (raw.includes(NO_FFMPEG)) return {
    kind: 'no_ffmpeg', title: 'Videos need ffmpeg', message: NO_FFMPEG, prompt: FFMPEG_PROMPT,
    text: "ffmpeg isn't installed, so this video can't play here. Pictures still work. Copy the prompt and paste it to Claude to install it, or run `brew install ffmpeg` yourself. No Homebrew? Get it from brew.sh first.",
  }
  if (/does not contain any stream|matches no streams|no frames in|Output file is empty/i.test(raw)) return {
    kind: 'no_picture', title: 'This video has no picture',
    text: `${name} has sound but no picture, so there's nothing to play.`,
    message: `${shown} has no video track (sound only), so there's nothing to play. Don't retry it; show a file with a picture instead.`,
    prompt: `${shown} has no picture, only sound. Find the right video and show it to me again.`,
  }
  if (/ffmpeg could not read|Invalid data|moov atom|could not find codec|Error opening input/i.test(raw)) return {
    kind: 'broken_video', title: "This video can't be read",
    text: `${name} couldn't be opened as a video. It may be cut off, still being written, or not really a video.`,
    message: `${shown} couldn't be read as a video: it's damaged, unfinished (still recording or cut off), or not a video. Re-export or re-record it, then show it again.`,
    prompt: `${shown} couldn't be read as a video. Check it, re-export or re-record it if it's broken, then show it to me again.`,
  }
  if (/could not convert|not an image|Cannot extract image|sips/i.test(raw)) return {
    kind: 'not_image', title: "This isn't a picture",
    text: `${name} isn't a picture, so it can't be shown. Pictures can be PNG, JPEG, WebP, GIF or TIFF.`,
    message: `${shown} isn't a picture (show_image opens PNG, JPEG, WebP, GIF and TIFF). Show an image file, or use show_video for a video.`,
    prompt: `${shown} isn't a picture. Show me the right file instead.`,
  }
  if (/ENOENT|no such file|not found/i.test(raw)) return {
    kind: 'missing', title: 'File not found',
    text: `There's no file at ${shown}.`,
    message: `There's no file at ${shown}. Check the path (it may have moved or not been saved yet), then show it again.`,
    prompt: `There's no file at ${shown}. Find the right file and show it to me again.`,
  }
  const detail = (raw.split('\n')[0] ?? '').replace(/\/(?:private\/)?tmp\/\S+|\S*\/\.show-your-work\/\S+/g, name).slice(0, 160)
  return {
    kind: 'other', title: "Couldn't show it",
    text: `${name} couldn't be shown: ${detail}`,
    message: `${shown} couldn't be shown: ${detail}`,
    prompt: `${shown} couldn't be shown (${detail}). Look into it and show it to me again.`,
  }
}

// The usage-stats reason for a failure, as a kind.
const REASONS: Record<NoticeKind, string> = {
  missing: 'missing_file', no_ffmpeg: 'video_tools', not_image: 'unreadable', broken_video: 'unreadable', no_picture: 'unreadable', other: 'other',
}

// Cuts a clip into PNG frames the terminal can swap through.
// A file as it is now: its path, size and modified time. The same unchanged
// file shown again maps to the same frames folder and skips the decode; a
// re-rendered one gets a new key and decodes fresh.
export function keyOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0') + text.length.toString(16)
}
async function identityOf($: EngineInterface, raw: string): Promise<string | undefined> {
  const st = await $.fs.stat(expand(raw, cwd, home), { resolve: true }).catch(() => null)
  return st ? keyOf(`${st.realPath ?? raw}|${st.size}|${st.mtimeMs}`) : undefined
}
async function readMeta<T>($: EngineInterface, dir: string): Promise<T | null> {
  const r = await $.process.run(['cat', `${dir}/meta.json`]).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try { return JSON.parse(r.stdout) as T } catch { return null }
}
const writeMeta = ($: EngineInterface, dir: string, meta: unknown) =>
  $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0/meta.json"', dir, JSON.stringify(meta)]).catch(() => undefined)

async function prepareVideo($: EngineInterface, real: string, title: string, key?: string, cutAt?: number): Promise<Shown> {
  if (!hasVideoTools) {
    hasVideoTools = (await Promise.all([exists($, ffmpeg), exists($, ffprobe)])).every(Boolean)
    if (!hasVideoTools) throw new Error(noFfmpeg(isMac))
  }
  const facts = await $.process.run([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'default=nw=1', real])
  const field = (name: string) => Number(new RegExp(`^${name}=([0-9.]+)`, 'm').exec(facts.stdout)?.[1] ?? NaN)
  const cut = cutAt ?? frameWidth(field('width'), field('height'), termSize, cell)
  const own = field('width') > 0 && field('height') > 0 ? { sourceWidth: field('width'), sourceHeight: field('height') } : {}
  // A clip is cut once per width: a bigger window cuts it again, bigger.
  const folder = key && `v-${keyOf(`${key}|${cut}${sendBytes ? '|bytes' : ''}`)}`
  // The same file shown before: its folder, frames and size are already there.
  if (folder) {
    const dir = `${TMP}/${folder}`
    const meta = await readMeta<{ frames: Omit<Frames, 'dir'>; width: number; height: number }>($, dir)
    if (meta) {
      const frames = { ...meta.frames, dir }
      await $.process.run(['touch', dir]).catch(() => undefined)
      await ensureChunk($, frames, real, 0)
      return { kind: 'video', path: frameFile(frames, 0), source: real, width: meta.width, height: meta.height, ...own, title, generation: ++generation, frames }
    }
  }
  // Some recordings (MediaRecorder webm) carry no duration: sample those at the
  // top rate. The clip's length is then what the frames cover.
  const probed = field('duration')
  const fps = sampleRate(Number.isFinite(probed) && probed > 0 ? probed : 1)
  generation += 1
  const dir = folder ? `${TMP}/${folder}` : `${TMP}/v${generation}-${Math.floor(await $.clock.now())}`
  await $.process.run(['mkdir', '-p', dir])
  const lead = await whiteLead($, real, probed)
  const known = Number.isFinite(probed) && probed > 0
  // A clip of known length is decoded as it plays, a chunk at a time (see
  // ensureChunk); one without (MediaRecorder webm) is cut whole, as before.
  const total = known ? Math.max(1, Math.min(MAX_FRAMES, Math.floor((probed - lead) * fps))) : 0
  const made = await $.process.run([
    // The palette waits for the end of its input: only the first chunk is read.
    ffmpeg, '-v', 'error', ...(lead ? ['-ss', String(lead)] : []), ...(known ? ['-t', chunkSeconds(Math.min(CHUNK, total), fps)] : []), '-i', real,
    '-vf', `fps=${fps},${scaleFor(cut)}`,
    '-frames:v', String(known ? Math.min(CHUNK, total) : MAX_FRAMES), '-compression_level', '1', `${dir}/f%05d.png`,
  ])
  if (made.exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: ${made.stderr.trim().slice(0, 200)}`)
  const pngs = (await $.fs.list(dir)).filter(f => f.name.endsWith('.png')).length
  if (!pngs) throw new Error(`no frames in ${real}`)
  const count = known ? Math.max(pngs, total) : pngs
  const frames = { dir, count, fps, duration: count / fps, cut, ...(lead ? { lead } : {}) }
  const poster = frameFile(frames, 0)

  const size = await pngSize($, poster)
  if (folder) await writeMeta($, dir, { frames: { count, fps, duration: frames.duration, cut, ...(lead ? { lead } : {}) }, ...size })
  void trimFrames($)
  return { kind: 'video', path: poster, source: real, ...size, ...own, title, generation, frames }
}

// Frames are decoded from the clip as it plays, two seconds at a time: the
// chunk on screen, the one before and the two after stay on disk, the rest
// go. A frame asked for again (a seek, a window scrolled back to) is decoded
// again. The poster, frame 1, always stays.
const CHUNK = 24
const decoding = new Map<string, Promise<void>>()
const exists = ($: EngineInterface, file: string) => $.fs.stat(file).then(() => true, () => false)
// Gone only when the disk says so; no answer at all (no fs here) is not gone.
const isGone = ($: EngineInterface, file: string) =>
  $.fs.stat(file).then(() => false, (e: unknown) => /ENOENT|not found|no such file/i.test(String((e as Error)?.message ?? e)))

// Chunks whose frames were cut: playback waits on any other. Only a hint:
// cutting still checks the files, so a chunk the cache cleaner took comes back.
const cutChunks = new Set<string>()
const chunkKey = (f: Frames, i: number) => `${f.dir}#${Math.floor(Math.max(0, Math.min(i, f.count - 1)) / CHUNK)}`
const isFrameCut = (media: Shown, i: number) => !media.frames || cutChunks.has(chunkKey(media.frames, i))

// Over ssh every frame crosses as bytes: 256 colours, one palette per chunk,
// no dithering, halve them. Frames on this machine go by path in full colour.
const PALETTE = ',split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none'
// How much of the clip a chunk reads, a frame's slack included.
export const chunkSeconds = (frames: number, fps: number) => String(+((frames + 1) / fps).toFixed(3))
const scaleFor = (cut?: number) => (cut ? `scale=${cut}:-2` : "scale='min(1600,iw)':-2") + (sendBytes ? PALETTE : '')
// The width a picture or clip is made at when it's prepared: what an inline
// player in this terminal needs (see Sizing). 1600 px at most while unmeasured.
export function frameWidth(width: number, height: number, term: { columns: number; rows: number } | null, px: Cell | null) {
  if (!term || !px || !width || !height) return Math.min(1600, width)
  const layout = layoutOf({ columns: term.columns, rows: term.rows, isPane: false, hasReport: false })
  return pixelsFor(targetBox(width, height, layout, px), px, width / height)
}

function ensureChunk($: EngineInterface, f: Frames, source: string | undefined, i: number): Promise<void> {
  const c = Math.floor(Math.max(0, Math.min(i, f.count - 1)) / CHUNK)
  const key = `${f.dir}#${c}`
  const running = decoding.get(key)
  if (running) return running
  const job = (async () => {
    const first = c * CHUNK
    // The frame asked for, not the chunk's first: the poster outlives its chunk.
    if (await exists($, frameFile(f, Math.max(0, Math.min(i, f.count - 1))))) return
    if (!source) return
    const cutAt = Date.now()
    await $.process.run(['mkdir', '-p', f.dir])
    await $.process.run([
      ffmpeg, '-v', 'error', '-ss', String(+((f.lead ?? 0) + first / f.fps).toFixed(3)), '-t', chunkSeconds(Math.min(CHUNK, f.count - first), f.fps), '-i', source,
      '-vf', `fps=${f.fps},${scaleFor(f.cut)}`, '-frames:v', String(Math.min(CHUNK, f.count - first)),
      '-start_number', String(first + 1), '-compression_level', '1', `${f.dir}/f%05d.png`,
    ])
    debug(`cut chunk=${c} ms=${Date.now() - cutAt}`)
    await prune($, f.dir, c)
  })().then(() => { cutChunks.add(key) }, () => undefined).finally(() => decoding.delete(key))
  decoding.set(key, job)
  return job
}

// Where each player is in each frames folder, as a chunk number.
const watching = new Map<string, Map<string, number>>()
function watch(dir: string, site: string, i: number) {
  let at = watching.get(dir)
  if (!at) watching.set(dir, (at = new Map()))
  at.set(site, Math.floor(i / CHUNK))
}

// Keeps, in a frames folder, chunks c-1 to c+2 around the chunk just made
// and around every player on that folder, and the poster.
async function prune($: EngineInterface, dir: string, c: number) {
  const keep = [c, ...(watching.get(dir)?.values() ?? [])]
  const files = await $.fs.list(dir).catch(() => [])
  const gone = files.map(f => f.name).filter(name => {
    const m = /^f(\d+)\.png$/.exec(name)
    if (!m) return false
    const i = Number(m[1]) - 1
    return i > 0 && !keep.some(k => i >= (k - 1) * CHUNK && i < (k + 3) * CHUNK)
  })
  if (gone.length) {
    for (const k of [...cutChunks]) if (k.startsWith(`${dir}#`) && !keep.some(c2 => { const j = Number(k.slice(dir.length + 1)); return j >= c2 - 1 && j <= c2 + 2 })) cutChunks.delete(k)
    await $.process.run(['rm', '-f', ...gone.map(n => `${dir}/${n}`)]).catch(() => undefined)
  }
}

// The frame a side shows, decoded if it has to be; past the middle of a
// chunk, the next one starts decoding so playback never waits.
async function frameReady($: EngineInterface, media: Shown, i: number, site?: string): Promise<void> {
  const f = media.frames
  if (!f) return
  if (site) watch(f.dir, site, i)
  await ensureChunk($, f, media.source, i)
  if (i % CHUNK >= CHUNK / 2 && i + CHUNK < f.count) void ensureChunk($, f, media.source, i + CHUNK)
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

// Every `stride`-th frame as a 32×18 grey thumbnail, for matching the two
// runs by eye. Small and sparse on purpose: matching costs frames × frames.
async function thumbs($: EngineInterface, media: Shown, stride: number): Promise<number[][]> {
  const f = media.frames!
  const r = await $.process.run([
    'sh', '-c',
    `"$0" -v error ${f.lead ? `-ss ${f.lead} ` : ''}-i "$1" -vf "fps=${f.fps},select=not(mod(n\\,${stride})),scale=32:18,format=gray" -fps_mode passthrough -frames:v ${Math.ceil(f.count / stride)} -f rawvideo - | od -An -tu1 -v`,
    ffmpeg, media.source ?? '',
  ])
  const px = r.stdout.trim().split(/\s+/).map(Number)
  const out: number[][] = []
  for (let i = 0; i + 576 <= px.length; i += 576) out.push(px.slice(i, i + 576))
  return out
}

// How many frames apart to sample so neither run has more than 240.
export const strideFor = (a: number, b: number) => Math.max(1, Math.ceil(Math.max(a, b) / 240))

// A match made on sampled frames, spread back over every updated frame.
export function spreadMatch(sampled: number[], stride: number, count: number, last: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const k = Math.min(sampled.length - 1, Math.floor(i / stride))
    return Math.min(last, (sampled[k] ?? 0) * stride + (i % stride))
  })
}

// What moved since the previous frame: the cursor, a fade, a scroll. The two
// runs move the same way even where the designs differ.
const motion = (f: number[][]) => f.map((px, i) => (i ? px.map((v, k) => v - f[i - 1]![k]!) : px.map(() => 0)))

// The cheapest way to walk both runs in order, frame by frame (dynamic time
// warping), matching how frames look and how they move: [updated, original]
// frame pairs. Holding one side still costs a little, so it only holds where
// the runs really differ. Within `band` samples of the same moment only, and
// straying from it costs `drift`: two runs of the same steps keep time, so a
// screen that looks different in one (an error the other never shows) can't
// pull one side ahead of the other.
export function align(a: number[][], b: number[][], hold = 0.01, band = Infinity, drift = 0): [number, number][] {
  const n = a.length, m = b.length
  if (!n || !m) return []
  const slope = n > 1 ? (m - 1) / (n - 1) : 0
  // Typed rows: the inner loop runs n × m × pixels times.
  const ta = a.map(x => Int16Array.from(x)), tb = b.map(x => Int16Array.from(x))
  const ma = motion(a).map(x => Int16Array.from(x)), mb = motion(b).map(x => Int16Array.from(x))
  const diff = (i: number, j: number) => {
    let d = 0, e = 0
    const pa = ta[i]!, pb = tb[j]!, qa = ma[i]!, qb = mb[j]!
    for (let k = 0; k < pa.length; k++) {
      const x = pa[k]! - pb[k]!, y = qa[k]! - qb[k]!
      d += x < 0 ? -x : x
      e += y < 0 ? -y : y
    }
    return (d + 4 * e) / (pa.length * 255)
  }
  const cost = new Float64Array(n * m)
  const step = new Uint8Array(n * m) // 0 both, 1 updated only, 2 original only
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const off = Math.abs(j - i * slope)
      if (off > band && !(i === n - 1 && j === m - 1) && (i || j)) { cost[i * m + j] = Infinity; step[i * m + j] = 0; continue }
      const d = diff(i, j) + drift * off
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

// The narrowest the scrub and button rows get, in columns: room for the play
// button, both times, a usable bar and the action buttons on one line.
const CONTROLS_MIN = 64
// The largest still kept whole.
const MAX_STILL = 3200

// Pixels between Original and Updated in the merged clip.
const PAIR_GAP = 40
// How tall the merged clip is cut: the shorter side's height, 720 px at most.
// The terminal never draws a picture larger than it is, so 360 px kept the
// side by side view small in any window.
export const pairHeightOf = (updated: { height: number }, original: { height: number }) =>
  Math.max(2, Math.floor(Math.min(720, updated.height || 720, original.height || 720) / 2) * 2)

// Merges the original and updated recordings into one clip, side by side.
// The original's frames are matched to the updated clip's by how they look,
// so every step happens at the same moment on both sides.
async function preparePair($: EngineInterface, original: Shown, updated: Shown) {
  const f = updated.frames!, g = original.frames!
  generation += 1
  // p2: pairs made before the time-first matching are never reused.
  const dir = `${TMP}/p2-${keyOf(f.dir + '|' + g.dir + '|' + pairHeightOf(updated, original))}`
  type PairMeta = { pair: Omit<Frames, 'dir'>; pairWidth: number; pairHeight: number; sync: [number, number][] }
  const known = await readMeta<PairMeta>($, dir)
  if (known) {
    const pair = { ...known.pair, dir }
    await $.process.run(['touch', dir]).catch(() => undefined)
    await pairChunk($, pair, updated, original, i => compareFrame({ ...updated, compare: original, sync: known.sync }, i), 0)
    return { pair, pairWidth: known.pairWidth, pairHeight: known.pairHeight, sync: known.sync }
  }
  // Two runs of the same steps take about as long: then the same moment on
  // both sides is the same second (moved to the checks' own moments when
  // they're given). Only runs that differ a lot are matched by how they look.
  const byTime = () => Array.from({ length: f.count }, (_, i) => Math.min(g.count - 1, Math.round(mapTime(anchors(updated.checks, original.checks), i / f.fps, f.duration, g.duration) * g.fps)))
  const isSamePace = Math.abs(f.duration - g.duration) <= 0.15 * Math.max(f.duration, g.duration)
  const stride = strideFor(f.count, g.count)
  const [ta, tb] = isSamePace ? [[], []] : await Promise.all([thumbs($, updated, stride), thumbs($, original, stride)])
  const match = ta.length && tb.length
    ? spreadMatch(matchOf(align(ta, tb, 0.01, Math.max(2, Math.round((0.6 * f.fps) / stride)), 0.02), ta.length), stride, f.count, g.count - 1)
    : byTime()
  await $.process.run(['mkdir', '-p', dir])
  const pair = { dir, count: f.count, fps: f.fps, duration: f.duration }
  await pairChunk($, pair, updated, original, i => match[i] ?? 0, 0)
  if (!(await exists($, frameFile(pair, 0)))) return null
  const size = await pngSize($, frameFile(pair, 0))
  const made = { pair, pairWidth: size.width, pairHeight: size.height, sync: turns(match, f.fps, g.fps) }
  await writeMeta($, dir, { ...made, pair: { count: pair.count, fps: pair.fps, duration: pair.duration } })

  return made
}

// One chunk of the merged clip, Original left and Updated right, made from
// the two sides' frames for that stretch (decoded first if they have to be).
function pairChunk($: EngineInterface, pair: Frames, updated: Shown, original: Shown, jOf: (i: number) => number, i: number): Promise<void> {
  const c = Math.floor(Math.max(0, Math.min(i, pair.count - 1)) / CHUNK)
  const key = `${pair.dir}#${c}`
  const running = decoding.get(key)
  if (running) return running
  const f = updated.frames!, g = original.frames!
  const job = (async () => {
    const first = c * CHUNK, n = Math.min(CHUNK, pair.count - first)
    if (await exists($, frameFile(pair, Math.max(0, Math.min(i, pair.count - 1))))) return
    const js = Array.from({ length: n }, (_, k) => Math.max(0, Math.min(g.count - 1, jOf(first + k))))
    await ensureChunk($, f, updated.source, first)
    for (const jc of new Set(js.map(j => Math.floor(j / CHUNK)))) await ensureChunk($, g, original.source, jc * CHUNK)
    const tmp = `${pair.dir}/c${c}`
    await $.process.run(['mkdir', '-p', `${tmp}/o`, `${tmp}/u`])
    const links = js.map((j, k) => `ln -sf "${frameFile(g, j)}" "$0/o/f${String(k + 1).padStart(5, '0')}.png"; ln -sf "${frameFile(f, first + k)}" "$0/u/f${String(k + 1).padStart(5, '0')}.png"`).join('\n')
    await $.process.run(['sh', '-c', links, tmp])
    await $.process.run([
      ffmpeg, '-v', 'error', '-framerate', String(f.fps), '-i', `${tmp}/o/f%05d.png`, '-framerate', String(f.fps), '-i', `${tmp}/u/f%05d.png`,
      '-filter_complex', `[0:v]scale=-2:${pairHeightOf(updated, original)},pad=iw+${PAIR_GAP}:ih:0:0:color=${SIDEBAR.replace('#', '0x')}[a];[1:v]scale=-2:${pairHeightOf(updated, original)}[b];[a][b]hstack=inputs=2`,
      '-frames:v', String(n), '-start_number', String(first + 1), '-compression_level', '1', `${pair.dir}/f%05d.png`,
    ])
    await $.process.run(['rm', '-rf', tmp])
    await prune($, pair.dir, c)
  })().catch(() => undefined).finally(() => decoding.delete(key))
  decoding.set(key, job)
  return job
}

// The merged frame on screen, made if it has to be, the next chunk ahead.
async function pairReady($: EngineInterface, shown: Shown, i: number, site?: string): Promise<void> {
  const pair = shown.pair
  if (!pair || !shown.compare) return
  if (site) watch(pair.dir, site, i)
  const jOf = (k: number) => compareFrame(shown, k)
  await pairChunk($, pair, shown, shown.compare, jOf, i)
  if (i % CHUNK >= CHUNK / 2 && i + CHUNK < pair.count) void pairChunk($, pair, shown, shown.compare, jOf, i + CHUNK)
}

// Resolves a path to something the terminal can draw: a PNG (other image
// formats converted with macOS `sips`), or a video's frames.
async function prepare($: EngineInterface, raw: string, title?: string, key?: string): Promise<Shown> {
  const path = expand(raw, cwd, home)
  const stat = await $.fs.stat(path, { resolve: true })
  const real = stat.realPath ?? path
  const name = title ?? real.split('/').pop()!
  if (VIDEO.test(real)) return prepareVideo($, real, name, key ?? (await identityOf($, real)))
  let png = real
  if (!/\.png$/i.test(real)) {
    generation += 1
    png = `${TMP}/${real.split('/').pop()!.replace(/\.[^.]+$/, '')}-${generation}.png`
    await $.process.run(['mkdir', '-p', TMP])
    if (!isMac && !(await exists($, ffmpeg))) throw new Error(noFfmpeg(false))
    const conv = isMac
      ? await $.process.run(['sips', '-s', 'format', 'png', real, '--out', png])
      : await $.process.run([ffmpeg, '-v', 'error', '-y', '-i', real, '-frames:v', '1', png])
    if (conv.exitCode !== 0) throw new Error(`could not convert ${real}: ${conv.stderr.trim()}`)
  }
  // The terminal reads the file itself, so only a picture past what any
  // screen shows is shrunk.
  const dims = await pngSize($, png)
  if (Math.max(dims.width, dims.height) > MAX_STILL) {
    generation += 1
    const small = `${TMP}/${png.split('/').pop()!.replace(/\.png$/i, '')}-${generation}-small.png`
    await $.process.run(['mkdir', '-p', TMP])
    const shrunk = isMac
      ? await $.process.run(['sips', '-Z', String(MAX_STILL), png, '--out', small])
      : await $.process.run([ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', `scale='if(gt(iw,ih),min(${MAX_STILL},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_STILL},ih))'`, small]).catch(() => ({ exitCode: 1 }))
    if (isMac || shrunk.exitCode === 0) png = small
  }
  // A picture narrower than the window shows it is drawn that wide, as a
  // video's frames are, so a picture and a video of one shape are one size.
  // Never past twice its own width: a small icon stays small.
  const now = await pngSize($, png)
  const wide = Math.min(frameWidth(now.width, now.height, termSize, cell), now.width * 2)
  if (wide > now.width) {
    generation += 1
    const big = `${TMP}/${png.split('/').pop()!.replace(/\.png$/i, '')}-${generation}-w${wide}.png`
    await $.process.run(['mkdir', '-p', TMP])
    const grown = isMac
      ? await $.process.run(['sips', '--resampleWidth', String(wide), png, '--out', big]).catch(() => ({ exitCode: 1 }))
      : await $.process.run([ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', `scale=${wide}:-2:flags=lanczos`, big]).catch(() => ({ exitCode: 1 }))
    if (grown.exitCode === 0) png = big
  }
  generation += 1

  return { kind: 'image', path: png, source: real, ...(await pngSize($, png)), sourceWidth: dims.width, sourceHeight: dims.height, title: name, generation }
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

// The line a version is listed by: what changed in it.
// A version's label: its first change, and how many more there were.
export function noteOf(changes: KeyChange[] | undefined, change: string | undefined, title: string | undefined): string {
  const titles = (changes ?? []).map(c => c.title.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const more = titles.length > 1 ? ` and ${titles.length - 1} more` : ''
  return (titles.length ? titles[0] + more : change ?? title ?? '').slice(0, 200)
}

// One line, whatever the length: cut at a word, with … where it was cut.
export function oneLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  width = Math.max(4, Math.floor(width))
  if (flat.length <= width) return flat
  const cut = flat.slice(0, width - 1)
  const space = cut.lastIndexOf(' ')
  return (space > width / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '') + '…'
}

// Earlier versions as given: paths or { path, note }, as an array or the
// same array sent as JSON text.
export function versionsOf(value: unknown): { path: string; note?: string }[] {
  if (typeof value === 'string') {
    const text = value
    try { value = JSON.parse(text) } catch { return text ? [{ path: text }] : [] }
  }
  if (!Array.isArray(value)) return []
  return value.flatMap(v =>
    typeof v === 'string' ? [{ path: v }]
      : v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string'
        ? [{ path: (v as { path: string }).path, note: typeof (v as { note?: unknown }).note === 'string' ? (v as { note: string }).note : undefined }]
        : [])
}

// Every shown file is kept as a version, in .show-your-work/ inside the
// project (it ignores itself in git), so old rows keep their picture and the
// history survives restarts. Each version gets a short handle; a revision
// names its parent's handle as `previous`, so history is a chain of explicit
// links, like commits. No file names are matched: forget the link and there's
// no history, never a wrong one.
type Version = { id: string; parent?: string; note?: string; ext: string; title?: string; origin?: string }
export const handleOf = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/^#/, '').toLowerCase() : '') || undefined
let storeDir = ''
// Everything the plugin keeps is at most 1 GB: 500 MB of frames (a cache, cut
// again when needed) and 500 MB of history across every project together.
const HISTORY_CAP_KB = 500_000
// Every history folder this install has used, so the cap spans all of them.
const HISTORY_DIRS = 'historyDirs'
// Deletes the oldest versions across the history folders in $3… until they
// hold $1 KB at most, never the one just kept ($2); only folders this user
// owns, never through a link, only the plugin's own record names.
export const HISTORY_TRIM_SH = [
  'cap=$1 keep=$2; shift 2',
  'ok() { [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }',
  'total=0; for d in "$@"; do ok "$d" && total=$((total + $(du -sk "$d" | cut -f1))); done',
  '[ "$total" -le "$cap" ] && exit 0',
  'R="[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"',
  'for d in "$@"; do ok "$d" || continue; for f in "$d"/$R.json; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")" "$f"; done; done |',
  '  sort -n | while IFS="$(printf "\\t")" read -r t f; do',
  '    [ "$total" -le "$cap" ] && break',
  '    [ "$f" = "$keep" ] && continue',
  '    base=${f%.json}; size=$(du -sk "$base".* 2>/dev/null | awk \'{s += $1} END {print s + 0}\'); rm -f -- "$base".*; total=$((total - size))',
  '  done; true',
].join('\n')
async function storeOf($: EngineInterface): Promise<string> {
  if (storeDir) return storeDir
  for (const dir of [`${cwd || home}/.show-your-work`, `${TMP}/store`]) {
    // Never through a link (a repo could commit `.show-your-work -> ..`), and
    // only a folder this user owns.
    const r = await $.process.run(['sh', '-c', '[ -L "$0" ] && exit 1; mkdir -p "$0" && [ ! -L "$0" ] && [ -O "$0" ] && { [ -f "$0/.gitignore" ] || printf "*\\n" > "$0/.gitignore"; }', dir]).catch(() => null)
    if (r && r.exitCode === 0) {
      const dirs = ((await $.store.get(HISTORY_DIRS)) as string[] | undefined) ?? []
      if (!dirs.includes(dir)) await $.store.set(HISTORY_DIRS, [dir, ...dirs].slice(0, 200))
      return (storeDir = dir)
    }
  }
  return (storeDir = `${TMP}/store`)
}
async function readVersion($: EngineInterface, dir: string, id: string): Promise<Version | null> {
  if (!/^[0-9a-f]{4,12}$/.test(id)) return null
  const r = await $.process.run(['cat', `${dir}/${id}.json`]).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  // A record's id and extension become paths that are later deleted: only
  // the plugin's own shapes pass.
  try {
    const v = JSON.parse(r.stdout) as Version
    return /^[0-9a-f]{4,12}$/.test(v.id) && /^(\.[A-Za-z0-9]{1,5})?$/.test(v.ext ?? '') ? v : null
  } catch { return null }
}
async function storeVersion($: EngineInterface, raw: string, note: string, title: string | undefined, parent: string | undefined):
  Promise<{ real: string; copy: string; id: string; chain: { path: string; note?: string; id: string }[]; missing?: string }> {
  const real = (await $.fs.stat(expand(raw, cwd, home), { resolve: true })).realPath ?? expand(raw, cwd, home)
  const dir = await storeOf($)
  const ext = real.match(/\.[^./]+$/)?.[0] ?? ''
  generation += 1
  const id = keyOf(`${real}|${await $.clock.now()}|${generation}`).slice(0, 6)
  const meta: Version = { id, ...(parent ? { parent } : {}), note, ext, title, origin: real }
  const r = await $.process.run(['sh', '-c',
    '[ ! -L "$0" ] && [ -O "$0" ] || exit 1\n' +
    'cp -c "$1" "$0/$2$3" 2>/dev/null || cp --reflink=auto "$1" "$0/$2$3" 2>/dev/null || cp "$1" "$0/$2$3" || exit 1\n' +
    'printf "%s" "$4" > "$0/$2.json"\n' +
    // Pictures and videos alike: kept 7 days, at most the newest 50 a
    // project; the oldest go first, file and record together. Inside the
    // store, by bare name: a path with spaces never reaches rm.
    'cd -P "$0" || exit 0\n' +
    'R="[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"\n' +
    'find . -maxdepth 1 -name "$R.json" -mtime +7 | while IFS= read -r f; do f=${f#./}; rm -f "./${f%.json}".*; done\n' +
    'ls -t -- $R.json 2>/dev/null | tail -n +51 | while IFS= read -r f; do rm -f "./${f%.json}".*; done; true',
    dir, real, id, ext, JSON.stringify(meta)])
  if (r.exitCode !== 0) return { real, copy: real, id, chain: [] }
  // Then the cap across every project's history.
  const dirs = ((await $.store.get(HISTORY_DIRS)) as string[] | undefined) ?? [dir]
  void $.process.run(['sh', '-c', HISTORY_TRIM_SH, 'trim', String(HISTORY_CAP_KB), `${dir}/${id}.json`, ...dirs]).catch(() => undefined)
  // Follow the links back, oldest first.
  const chain: { path: string; note?: string; id: string }[] = []
  let at = parent, missing: string | undefined
  for (let n = 0; at && n < 30; n++) {
    const v = await readVersion($, dir, at)
    if (!v) { if (n === 0) missing = at; break }
    chain.unshift({ path: `${dir}/${v.id}${v.ext}`, note: v.note, id: v.id })
    at = v.parent
  }
  // A recording keeps only itself and the one before it: Original and
  // Updated, no deeper history, so re-recordings don't pile up.
  if (VIDEO.test(real) && chain.length > 1) {
    const older = chain.slice(0, -1)
    void $.process.run(['rm', '-f', ...older.map(v => v.path)]).catch(() => undefined)
    chain.splice(0, chain.length - 1)
  }
  return { real, copy: `${dir}/${id}${ext}`, id, chain, missing }
}

// The tool's text result carries the shown item as `show-your-work:{json}`;
// the output may be that string or a list of text blocks.
// A tool result's text, whether it came as a string or as content blocks.
export function textOf(output: unknown): string {
  return typeof output === 'string'
    ? output
    : Array.isArray(output)
      ? output.map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n')
      : ''
}
// What a show drew, kept out of Claude's context: the result carries only
// "show-your-work:#id", and the data waits here and in the store beside the copy.
const shownById = new Map<string, Shown>()
// The marker is the last line: a command's row also starts with the plugin's name.
export const markOf = (output: unknown) => textOf(output).split('\n').findLast(l => l.startsWith(MARK))?.slice(MARK.length).trim()
async function shownOf($: EngineInterface, output: unknown): Promise<Shown | null> {
  const mark = markOf(output)
  if (!mark?.startsWith('#')) return parseShown(output)
  const id = mark.slice(1)
  if (!/^[0-9a-f]{4,12}$/.test(id)) return null
  const known = shownById.get(id)
  if (known) return known
  const r = await $.process.run(['cat', `${await storeOf($)}/${id}.shown`]).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try {
    const shown = JSON.parse(r.stdout) as Shown
    shownById.set(id, shown)
    return shown
  } catch {
    return null
  }
}
export function parseShown(output: unknown): Shown | null {
  const text = textOf(output)
  const line = text.split('\n').findLast(l => l.startsWith(MARK))
  if (!line) return null
  try {
    return JSON.parse(line.slice(line.indexOf(':') + 1)) as Shown
  } catch {
    return null
  }
}

// ── Sizing ──────────────────────────────────────────────────────────────
// One path from the room a player has to the box it draws and the pixels its
// picture needs:
//   layoutOf(room)        the space: columns and rows for the picture, report beside or below
//   targetBox(w, h, ...)  the box a picture of that shape fills in it
//   pixelsFor(box, cell)  the screen pixels that box needs (PX_MIN to PX_MAX)
//   drawBox(w, h, ...)    the box drawn: the target, cut down to the picture's own pixels
// Ghostty draws a picture at its own pixel size at most, so pictures and
// frames are made as wide as their box (frameWidth when prepared, sharpen
// when a player needs more), and drawBox keeps a picture that's still short
// of pixels whole instead of small in a big box.
const PX_MIN = 320
const PX_MAX = 2400
export type Room = { columns: number; rows: number; isPane: boolean; hasReport: boolean }
export type Layout = { isWide: boolean; inner: number; maxCols: number; maxRows: number }
export function layoutOf(room: Room): Layout {
  const isWide = room.hasReport && room.columns - 8 >= WIDE_ENOUGH
  // The window's border and padding; a pane has no row border of its own.
  const inner = room.columns - (room.isPane ? 6 : 10)
  const space = inner - (isWide ? SIDE + 3 : 0)
  const maxCols = Math.max(1, Math.max(Math.min(space, 24), Math.min(space, room.isPane ? 220 : 120)))
  // Inline, a picture takes at most 55% of the screen's height; a pane keeps 12 rows for its controls.
  const maxRows = room.isPane ? Math.max(6, room.rows - 12) : Math.max(8, Math.min(40, Math.floor(room.rows * 0.55)))
  return { isWide, inner, maxCols, maxRows }
}
export const targetBox = (width: number, height: number, layout: Layout, px: Cell | null) =>
  fit(width, height, layout.maxCols, layout.maxRows, px, false)
export const drawBox = (width: number, height: number, layout: Layout, px: Cell | null) =>
  fit(width, height, layout.maxCols, layout.maxRows, px, true)
// Enough for the box's width and, given the picture's shape, its height:
// boxes are whole rows, so a wide picture sized by width alone falls short.
export const pixelsFor = (box: { columns: number; rows?: number }, px: Cell | null, aspect = 0) =>
  px ? Math.max(PX_MIN, Math.min(PX_MAX, Math.ceil(Math.max(box.columns * px.width, (box.rows ?? 0) * px.height * aspect) / 2) * 2)) : 1600

// Fits a picture in a box of cells, its own shape. With the cell's size in
// pixels known and `isCapped`, never past the picture's own pixels; unknown,
// a cell is about twice as tall as wide.
export function fit(width: number, height: number, maxCols: number, maxRows: number, px?: Cell | null, isCapped = true) {
  if (px) {
    const scale = Math.min(isCapped ? 1 : Infinity, (maxCols * px.width) / width, (maxRows * px.height) / height)
    // A hair over, so a box that fits exactly (38 rows, computed as 37.999…) keeps its last row.
    const rows = Math.max(1, Math.min(255, Math.floor((height * scale) / px.height + 1e-9)))
    const shown = isCapped ? Math.min(height, rows * px.height) : rows * px.height
    const columns = Math.max(1, Math.min(255, maxCols, Math.ceil((shown * width) / height / px.width)))
    return { columns, rows }
  }
  let columns = Math.max(1, Math.min(255, maxCols))
  let rows = Math.ceil((columns * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.ceil((rows * 2 * width) / height))
  }

  return { columns: Math.min(255, columns), rows: Math.max(1, Math.min(255, rows)) }
}

// A player whose box needs more pixels than its picture has (a bigger
// window, a pane, no report beside it) gets a sharper copy, made once in the
// background from the original file and swapped into the same object, so a
// playing video carries on. Stills stop at twice their own width (an icon
// stays small) and MAX_STILL; videos at PX_MAX.
const sharpKey = (m: Shown) => `${m.kind}|${m.source ?? m.path}`
const sharpening = new Map<string, number>()
const sharpest = new Map<string, Pick<Shown, 'path' | 'width' | 'height' | 'generation' | 'frames'>>()
function useSharpest(m: Shown) {
  const better = sharpest.get(sharpKey(m))
  if (better && better.width > m.width) Object.assign(m, better)
}
function sharpen($: EngineInterface, m: Shown, need: number) {
  const source = m.source
  const limit = m.frames ? PX_MAX : Math.min(MAX_STILL, (m.sourceWidth ?? m.width) * 2)
  const want = Math.min(limit, need)
  const key = sharpKey(m)
  if (!source || want < m.width * 1.15 || (sharpening.get(key) ?? 0) >= want) return
  sharpening.set(key, want)
  void (async () => {
    const made = m.frames
      ? await prepareVideo($, source, m.title, await identityOf($, source), want)
      : await widenStill($, source, want)
    if (!made) return
    sharpest.set(key, { path: made.path, width: made.width, height: made.height, generation: made.generation, frames: made.frames })
    useSharpest(m)
    redraw($)
  })().catch(() => undefined)
}
async function widenStill($: EngineInterface, source: string, width: number): Promise<Shown | null> {
  const out = `${TMP}/w-${keyOf(source)}-${width}.png`
  const made = isMac
    ? await $.process.run(['sips', '-s', 'format', 'png', '--resampleWidth', String(width), source, '--out', out]).catch(() => null)
    : await $.process.run([ffmpeg, '-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`, out]).catch(() => null)
  if (!made || made.exitCode !== 0) return null
  generation += 1
  return { kind: 'image', path: out, source, ...(await pngSize($, out)), title: '', generation }
}

// The drawn box for `room` columns already free of chrome (the pair view).
export function sizeFor(width: number, height: number, room: number, rows: number, isPane: boolean, px: Cell | null = cell) {
  return drawBox(width, height, layoutOf({ columns: room + (isPane ? 6 : 10), rows, isPane, hasReport: false }), px)
}

// The terminal's cell in pixels, from the size its tty reports; null where it
// reports none (tmux, a relay), and measured again when the window changes.
type Cell = { width: number; height: number }
let cell: Cell | null = null
// The terminal's size in cells, from the same measure.
let termSize: { columns: number; rows: number } | null = null
let cellFor = ''
export const CELL_SH = `perl -e 'open(T, "</dev/tty") or exit 1; my $w = " " x 8; ioctl(T, ($^O eq "darwin" ? 0x40087468 : 0x5413), $w) or exit 1; print join(" ", unpack("S4", $w))'`
// The tty's size is in points; pictures draw in screen pixels, `scale` to a
// point (2 on Retina).
export function cellOf(stdout: string, scale = 1): Cell | null {
  const [rows, columns, x, y] = stdout.trim().split(/\s+/).map(Number)
  return rows && columns && x && y ? { width: (x / columns) * scale, height: (y / rows) * scale } : null
}
const SCALE_SH = `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSScreen.mainScreen.backingScaleFactor'`
async function measureCells($: EngineInterface) {
  const [r, s] = await Promise.all([
    $.process.run(['sh', '-c', CELL_SH]).catch(() => null),
    isMac ? $.process.run(['sh', '-c', SCALE_SH]).catch(() => null) : null,
  ])
  const scale = Number(s?.stdout.trim()) || 1
  cell = r?.exitCode === 0 ? cellOf(r.stdout, scale) : null
  const [rows, columns] = (r?.exitCode === 0 ? r.stdout : '').trim().split(/\s+/).map(Number)
  termSize = rows && columns ? { columns, rows } : null
}
// Players of different widths each ask: one measure a second at most, the
// last ask still measured.
let measuredAt = 0
async function remeasure($: EngineInterface): Promise<boolean> {
  const wait = measuredAt + 1000 - (await $.clock.now())
  if (wait > 0) await $.clock.sleep(wait)
  measuredAt = await $.clock.now()
  const was = cell
  await measureCells($)
  return was?.width !== cell?.width || was?.height !== cell?.height
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
// Each side draws in a picture of its own: a frame of one side swapped into
// the other's picture would keep that one's size and place.
const viewKey = (site: string) => (player(site).isCompare ? 'view-original' : 'view')

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

type Source = { png: string } | { file: string; format: 'png'; generation?: number }

// The terminal reads the file itself: a path crosses, not the picture. Sending
// bytes (b6b8b14) moved ~400 KB a frame and froze playback.
// Over ssh the terminal is on another machine and can't read the file, so the
// bytes have to cross after all.
let sendBytes = false
// Claude Code takes at most 2 MiB of picture as bytes: a bigger one is sent as
// a smaller copy, made once with whatever the machine has (sips, ffmpeg or
// ImageMagick) and kept in the temp folder.
const BYTES_MAX = 2_000_000
export const SHRINK_SH = [
  'f="$0"; out="$1"; ff="$2"; max="$3"',
  'size() { wc -c < "$1" | tr -d " "; }',
  '[ "$(size "$f")" -le "$max" ] && { echo "$f"; exit 0; }',
  '[ -s "$out" ] && [ "$(size "$out")" -le "$max" ] && { echo "$out"; exit 0; }',
  'w=1600',
  'while [ "$w" -ge 200 ]; do',
  '  rm -f "$out"',
  '  if command -v sips >/dev/null 2>&1; then sips -s format png --resampleWidth "$w" "$f" --out "$out" >/dev/null 2>&1',
  '  elif [ -x "$ff" ]; then "$ff" -v error -y -i "$f" -vf "scale=$w:-2" "$out" </dev/null 2>/dev/null',
  '  elif command -v magick >/dev/null 2>&1; then magick "$f" -resize "${w}x" "$out" 2>/dev/null',
  '  elif command -v convert >/dev/null 2>&1; then convert "$f" -resize "${w}x" "$out" 2>/dev/null',
  '  else exit 1; fi',
  '  [ -s "$out" ] && [ "$(size "$out")" -le "$max" ] && { echo "$out"; exit 0; }',
  '  w=$((w * 3 / 4))',
  'done',
  'exit 1',
].join('\n')
const fitted = new Map<string, string>()
// The last few pictures read, so a button press that redraws the player
// doesn't read and send its picture from disk again.
const recentBytes = new Map<string, string>()
async function bytesOf($: EngineInterface, file: string): Promise<string | null> {
  const known = recentBytes.get(file)
  if (known) return known
  const png = await readBytes($, file)
  if (png) {
    recentBytes.set(file, png)
    if (recentBytes.size > 6) recentBytes.delete(recentBytes.keys().next().value!)
  }
  return png
}
async function readBytes($: EngineInterface, file: string): Promise<string | null> {
  // Most files (every video frame) are under the limit: read them as they are,
  // with no process started per frame.
  if (!fitted.has(file)) {
    const direct = await Promise.resolve().then(() => $.fs.read(file, { as: 'bytes' })).catch(() => null)
    if (direct?.base64 && direct.base64.length * 0.75 <= BYTES_MAX) return direct.base64
  }
  let small = fitted.get(file)
  if (!small) {
    const r = await Promise.resolve().then(() => $.process.run(['sh', '-c', SHRINK_SH, file, `${TMP}/b-${keyOf(file)}.png`, ffmpeg, String(BYTES_MAX)])).catch(() => null)
    small = r?.exitCode === 0 ? r.stdout.trim() : ''
    if (!small) return null
    fitted.set(file, small)
  }
  const loaded = await Promise.resolve().then(() => $.fs.read(small!, { as: 'bytes' })).catch(() => null)
  return loaded?.base64 ?? null
}
export async function pngSource($: EngineInterface, file: string): Promise<Source> {
  if (sendBytes) {
    const png = await bytesOf($, file)
    if (png) return { png }
  }
  return { file, format: 'png' as const }
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
      drawCause = causeOf(inTmux, terminalName)
      track('cannot_draw', { cause: drawCause })
      $.ui.toast("Pictures can't show here: see the notice in the chat.")
      redraw($)
    }
  }, () => undefined)
}

// One swap at a time per picture, the newest frame winning: a slow swap is
// never overtaken by the next (frames drawn out of order) and never queues
// up behind it (playback falling further behind each frame).
// Each draw takes a ticket; one whose frame was ready later than a newer
// draw's is stale and skipped.
const swaps = new Map<string, { isBusy: boolean; ticket: number; next?: { file: string; frame: number } }>()
let tickets = 0
async function blit($: EngineInterface, site: string, key: string, media: Shown, file: string, frame: number, ticket = ++tickets) {
  if (!canImage) return
  const id = `${site}|${key}`
  let lane = swaps.get(id)
  if (!lane) swaps.set(id, (lane = { isBusy: false, ticket: 0 }))
  if (ticket < lane.ticket) return void debug(`stale frame=${frame}`)
  lane.ticket = ticket
  if (lane.isBusy) {
    if (lane.next) debug(`drop frame=${lane.next.frame}`)
    lane.next = { file, frame }
    return
  }
  lane.isBusy = true
  let job: { file: string; frame: number } | undefined = { file, frame }
  try {
    while (job) {
      const at = Date.now()
      await $.ui.blit({ requestId: site, key, source: await pngSource($, job.file) })
      debug(`blit frame=${job.frame} ms=${Date.now() - at}`)
      job = lane.next
      lane.next = undefined
    }
  } finally {
    lane.isBusy = false
  }
}

function draw($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  if (one.isSplit && shown?.pair) {
    const at = Math.min(one.frame, shown.pair.count - 1), pair = shown.pair
    const ticket = ++tickets
    void pairReady($, shown, at, site).then(() => blit($, site, 'view-pair', shown, frameFile(pair, at), at, ticket)).catch(() => undefined)
    return
  }
  if (one.isSplit && shown?.compare) {
    const at = compareFrame(shown, one.frame), compare = shown.compare, frame = one.frame
    const ticket = ++tickets
    void frameReady($, compare, at, site).then(() => blit($, site, 'view-a', compare, plainAt(compare, at), at, ticket)).catch(() => undefined)
    void frameReady($, shown, frame, site).then(() => blit($, site, 'view-b', shown, plainAt(shown, frame), frame, ticket)).catch(() => undefined)
    return
  }
  const frame = one.frame
  const ticket = ++tickets
  void frameReady($, media, frame, site).then(() => blit($, site, viewKey(site), media, plainAt(media, frame), frame, ticket)).catch(() => undefined)
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
  // The clock never runs ahead of the frames: a tick whose next frame is
  // still being cut waits for it, so pressing play never skips ahead.
  let isWaiting = false
  let tickAt = Date.now()
  debug(`play fps=${frames.fps} count=${frames.count} from=${one.frame}`)
  one.timer = $.clock.every(Math.round(1000 / frames.fps), () => {
    debug(`tick gap=${Date.now() - tickAt} frame=${one.frame}${isWaiting ? ' waiting' : ''}`)
    tickAt = Date.now()
    if (one.frame >= frames.count - 1) return stop($, site)
    if (isWaiting) return
    const next = one.frame + 1
    if (!shown?.pair || !one.isSplit) {
      isWaiting = true
      void frameReady($, media, next, site).finally(() => { isWaiting = false })
      if (!isFrameCut(media, next)) return void debug(`wait frame=${next}`)
      isWaiting = false
    }
    one.frame = next
    draw($, site, media, shown)
    const now = marks()
    if (now !== last) {
      last = now
      debug('redraw')
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
  // A still is drawn by the redraw at its own size; a swap would put it in
  // the other side's box first.
  if (to.frames) draw($, site, to)
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
function Picture(ui: Ui, $: EngineInterface, site: string, shown: Shown, media: Shown, box: Box, pic: Pic, frame: Box = box) {
  const { Box, Text, Image } = ui
  if (!Image) return <Text dimColor>This surface cannot draw images.</Text>

  // The picture stands alone: no wrapper, nothing laid over it and no fill
  // behind it. Each of those kept the picture from drawing in Ghostty.
  // The same file in a box of another size (a resized window) is sent again:
  // the terminal keeps a picture at the size it was last sent at.
  const source = 'file' in pic.src ? { ...pic.src, generation: box.columns * 1000 + box.rows } : pic.src
  const image = (
    <Image
      key={viewKey(site)}
      source={source}
      columns={box.columns}
      rows={box.rows}
      alt={`[${media.kind ?? 'image'}: ${shown.title}]`}
    />
  )
  if (frame.columns === box.columns && frame.rows === box.rows) return image
  // A side smaller than the frame it shares sits centred in it, unfilled.
  return <Box width={frame.columns} height={frame.rows} justifyContent="center" alignItems="center">{image}</Box>
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

  // ~20 wide buttons, each a stretch you can jump to, playing or paused: the
  // bar redraws once a second, so the buttons cost little.
  const chunks = barChunks(segments, playhead)

  return (
    <Box flexDirection="row" flexWrap="nowrap" width={width}>
      <Button key="play" variant="primary" label={word} onPress={() => { act(word.includes('Pause') ? 'pause' : 'play'); if (!word.includes('Pause')) tourHeard($, 'play'); toggle($, site, media, shown) }} />
      <Text dimColor> {elapsed} </Text>
      {chunks.map((c, i) => (
        <Button
          key={`seek-${i}`}
          plain
          dimColor={c.isAhead}
          label={c.label}
          onPress={() => { act('scrub'); seek($, site, media, (Math.round((c.start / Math.max(1, segments - 1)) * (frames.count - 1)) + 0.5) / frames.fps, shown) }}
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

// Original / Updated / Compare (side by side): the view shown is the accent button.
// The compared side when it is one of several earlier versions: the one
// before by default, with ‹ › to step further back. Versions are numbered
// from the first one shown, so the updated side is the highest.
export function atStep(shown: Shown, site: string): Shown {
  const step = player(site).step
  const picked = step === undefined ? undefined : prepared.get(shown.history?.[step]?.path ?? '')
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

// Puts an earlier version on the original side, read the first time it is
// picked; the newest entry is the updated side itself.
function pickVersion($: EngineInterface, site: string, shown: Shown, to: number) {
  const history = shown.history!
  const one = player(site)
  if (one.isSplit) split($, site, shown, false)
  const picked = history[to]
  if (!picked) return flip($, site, shown, false)
  void preparedOf($, picked.path).then(version => {
    one.step = to
    if (!one.isCompare) flip($, site, { ...shown, compare: version }, true)
    else draw($, site, version)
    redraw($, site)
  }).catch(() => $.ui.toast('That version is gone'))
}

// With history, which version is on screen, in words: "viewing v1 of 3".
function viewingLabel(shown: Shown, site: string): string {
  const history = shown.history
  const one = player(site)
  if (!history || history.length < 2 || !one.isHistory) return ''
  const total = history.length + 1
  const at = one.isCompare ? (one.step ?? shown.historyAt ?? history.length - 1) + 1 : total
  return at === total ? `· latest, v${total}` : `· viewing v${at} of ${total}`
}

// A tab name short enough that every tab fits on one line and stays clickable.
export const tabLabel = (text: string, max = 12) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text)

// The player's zones, the same in every view:
//   TitleBar  the title (only it gives way), the side shown, the score, a PR link, the tabs
//   stage     the picture, the scrub bar and the buttons under it
//   Report    what changed or the versions, then QA: beside the stage when wide, else under it
// A tour's instructions sit in the tour's own header, never inside the player.
function TitleBar(ui: Ui, $: EngineInterface, site: string, shown: Shown, at: { width?: number; checks?: Check[]; pr?: Ui }) {
  const { Box, Text } = ui
  const checks = at.checks ?? []
  const passed = checks.filter(c => c.ok).length
  const viewing = viewingLabel(shown, site)
  return (
    <Box key="title-bar" flexDirection="row" justifyContent="space-between" gap={2} width={at.width}>
      <Box flexDirection="row" gap={2} flexShrink={1} flexGrow={1}>
        <Text bold wrap="truncate-end">{shown.title}</Text>
        {viewing && <Text color="suggestion" wrap="truncate-end">{viewing}</Text>}
        {checks.length > 0 && (
          <Text bold color={passed === checks.length ? 'success' : 'error'}>
            {passed === checks.length ? '✓' : '✗'} {passed}/{checks.length}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" gap={2} flexShrink={0}>
        {at.pr}
        {Tabs(ui, $, site, shown)}
      </Box>
    </Box>
  )
}

// The tab row's width: each Button draws as "[ label ]", one apart.
export function tabsWidth(shown: Shown) {
  if (!shown.compare) return 0
  const labels = [tabLabel(shown.compare.label ?? 'Original'), tabLabel(shown.label ?? 'Updated')]
  if (shown.frames && shown.pair) labels.push('⧉ Compare')
  if ((shown.history?.length ?? 0) > 1) labels.push(`History · ${shown.history!.length + 1}`)
  return labels.reduce((n, l) => n + l.length + 4, 0) + labels.length - 1
}
function Tabs(ui: Ui, $: EngineInterface, site: string, shown: Shown) {
  const { Box, Button } = ui
  if (!shown.compare) return null
  const one = player(site)
  // Original, Updated, Compare and History are separate views: one is lit.
  const isHistory = !!one.isHistory
  const isBoth = !isHistory && !!one.isSplit
  const isCompare = !isHistory && !isBoth && !!one.isCompare
  const isUpdated = !isHistory && !isBoth && !isCompare
  const canBoth = !!(shown.frames && shown.pair)
  const hasSteps = (shown.history?.length ?? 0) > 1
  // Original is always the version before; leaving History puts it back.
  const restore = (toCompare: boolean) => {
    const wasStepped = one.step !== undefined && one.step !== shown.historyAt
    one.isHistory = false
    one.step = undefined
    if (one.isSplit) split($, site, shown, false)
    if (wasStepped && one.isCompare) {
      one.isCompare = false
      if (toCompare) flip($, site, shown, true)
      else draw($, site, shown)
    } else flip($, site, shown, toCompare)
    redraw($, site)
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Button key="side-before" variant={isCompare ? 'primary' : 'secondary'} label={tabLabel(shown.compare.label ?? 'Original')} onPress={() => { act('original'); tourHeard($, 'original'); restore(true) }} />
      <Button key="side-after" variant={isUpdated ? 'primary' : 'secondary'} label={tabLabel(shown.label ?? 'Updated')} onPress={() => { act('updated'); restore(false) }} />
      {canBoth && <Button key="side-both" variant={isBoth ? 'primary' : 'secondary'} label="⧉ Compare" onPress={() => { act('compare'); tourHeard($, 'compare'); restore(false); split($, site, shown, true) }} />}
      {hasSteps && (
        <Button key="history" variant={isHistory ? 'primary' : 'secondary'} label={`History · ${shown.history!.length + 1}`}
          onPress={() => { if (isHistory) return restore(false); act('history'); one.isHistory = true; one.changesPage = 0; redraw($, site) }} />
      )}
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
      onPress={() => { if (c.at === undefined) return; act('check_jump'); seek($, site, media, c.at, shown) }}
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
  // Plain lines, a label and a tick each, with no checks to count: one apiece.
  if (!checks.length) return { passed: summary.filter(s => s.ok).length, total: summary.length }

  return { passed: checks.filter(c => c.ok).length, total: checks.length }
}

const PILL = '#30323b'
// The sidebar's top bar, a step lighter than the sidebar.
// Room for a change's title and a QA line, in a column this wide.
const titleWidth = (column: number) => column - 4 /* "12. " */ - 1 - 6 /* " 0:07 " */
const labelWidth = (column: number) => column - 4 /* card border + padding */ - 2 /* "✓ " */ - 5 /* " 11/11" */
// Under the player, what changed and the QA sit side by side from this width.
const TWO_COLUMNS = 72

// Rows the sidebar spends on everything but the change rows.
export function changesThatFit(height: number, summaryRows: number, hasPr: boolean) {
  const qa = summaryRows >= 0 ? 1 /* gap */ + 1 /* label */ + 2 /* card border */ + 1 /* verdict */ + summaryRows : 0
  const fixed = 2 /* padding */ + 1 /* label */ + qa + (hasPr ? 2 : 0)
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

// The report: the Original / Updated / Compare switch in a top bar, what changed
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
  const room = isBeside ? changesThatFit(height, total > 0 ? summaryRows : -1, !!prLink) : Infinity
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
        `${(shown.changesTitle || 'What changed').toUpperCase()} · ${changes.length}`,
        pages.length > 1 ? (
          <Button
            key="changes-more"
            plain
            dimColor
            label={`${page + 1}/${pages.length} ${page === pages.length - 1 ? '↑' : '↓'}`}
            onPress={() => {
              one.changesPage = (page + 1) % pages.length
              redraw($, site)
            }}
          />
        ) : undefined,
      )}
      {(pages[page] ?? []).map(({ c, n, lines }, k) => {
        const isLive = n === live
        // A change pauses on its moment, to be looked at; Play goes on from there.
        const jump = () => { if (c.at === undefined) return; act('change_jump'); tourHeard($, 'change_jump'); stop($, site); seek($, site, media, onOriginal ? toOriginal(shown, c.at) : c.at, shown) }
        return (
          <Box key={`change-${n}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isLive ? 'suggestion' : undefined} dimColor={!isLive}>{`${n + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={TITLE}>
              {lines.map((line, i) =>
                c.at !== undefined
                  ? <Button key={`change-${n}-${i}`} plain label={line} hover={{ inverse: true }} onPress={jump} />
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
  // The versions, newest first, each by what changed in it; the one on the
  // original side is lit, and a click puts another there.
  const history = one.isHistory ? shown.history : undefined
  const onSide = one.isCompare ? one.step ?? shown.historyAt ?? (history?.length ?? 1) - 1 : (history?.length ?? 0)
  const versions = history ? [...history, { path: '', note: shown.note }].map((v, i) => ({ v, i })).reverse() : []
  // Each version one line, so a long note and a one-word one line up alike.
  // Room for " viewing " (9) beside the label, as TITLE leaves room for a time.
  const VERSION = column - 4 - 1 - 9
  const listed = versions.map(({ v, i }) => ({ i, lines: [oneLine(v.note || (i === history!.length ? 'This version' : `Version ${i + 1}`), VERSION)] }))
  const versionPages = pagesOf(listed.map((w, k) => ({ item: w, rows: w.lines.length + (k ? 1 : 0) })), room)
  const versionPage = Math.min(one.changesPage ?? 0, versionPages.length - 1)
  const versionList = history && (
    <Box flexDirection="column" width={column}>
      {label(
        `VERSIONS · ${versions.length}`,
        versionPages.length > 1 ? (
          <Button key="versions-more" plain dimColor label={`${versionPage + 1}/${versionPages.length} ${versionPage === versionPages.length - 1 ? '↑' : '↓'}`}
            onPress={() => { one.changesPage = (versionPage + 1) % versionPages.length; redraw($, site) }} />
        ) : undefined,
      )}
      {(versionPages[versionPage] ?? []).map(({ i, lines }, k) => {
        const isOn = i === onSide
        const isLatest = i === history.length
        return (
          <Box key={`version-${i}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isOn ? 'suggestion' : undefined} dimColor={!isOn}>{`${i + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={VERSION}>
              {lines.map((line, j) => (
                <Button key={`version-${i}-${j}`} plain label={line} hover={{ inverse: true }} onPress={() => { act('version_pick'); tourHeard($, 'version_pick'); pickVersion($, site, shown, i) }} />
              ))}
            </Box>
            {(isOn || isLatest) && (
              <Text backgroundColor={isOn ? 'suggestion' : PILL} color={isOn ? 'inverseText' : undefined}>
                {isOn ? ' viewing ' : ' latest '}
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
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {versionList || (
          <Box flexDirection="column">
            {changes.length > 0 && (isTwo ? <Box flexDirection="row" gap={3}>{changed}{qa}</Box> : changed)}
            {(!isTwo || !changes.length) && qa}
          </Box>
        )}
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
    if (!isMac) await $.process.run(['mkdir', '-p', `${home}/Downloads`])
    const r = await $.process.run(['cp', source, out])
    if (r.exitCode === 0) await $.process.run(isMac ? ['open', '-R', out] : ['xdg-open', `${home}/Downloads`]).catch(() => undefined)
    done(r, `Saved to Downloads/${out.split('/').pop()}`)
  }

  return (
    <Box flexDirection="row" gap={2}>
      {!source.startsWith(`${home}/Downloads/`) ? (
        <Button key="keep" plain dimColor label="Save to Downloads" onPress={() => { act('save'); void keep() }} />
      ) : (
        <Button key="reveal" plain dimColor label={isMac ? 'Show in Finder' : 'Show in folder'} onPress={() => act('reveal') || void $.process.run(isMac ? ['open', '-R', source] : ['xdg-open', source.slice(0, source.lastIndexOf('/')) || '/']).then(r => done(r, isMac ? 'Shown in Finder' : 'Opened the folder'))} />
      )}
      {!isNarrow && (
        <Button
          key="copy"
          plain
          dimColor
          label="Copy path"
          onPress={(press: { surface: 'terminal' }) =>
            act('copy_path') || void $.ui.copy({ text: source, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path'))
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
// A session still running in the background can't be resumed: it's stopped first.
export const resumeCommand = (id: string) =>
  id ? `claude stop ${id}; CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume ${id}` : 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume'

// Why pictures can't draw here, once a draw has failed: tmux blocking them,
// a terminal without picture support, or a background session.
export type DrawCause = 'tmux' | 'terminal' | 'background'
let drawCause: DrawCause = 'background'
let inTmux = false
// SHOW_YOUR_WORK_DEBUG=1: playback timings, a line per event, in TMP/debug.log.
let isDebug = false
const debugLines: string[] = []
const debug = (line: string) => { if (isDebug) debugLines.push(`${Date.now()} ${line}`) }
async function flushDebug($: EngineInterface) {
  if (!debugLines.length) return
  await $.fs.write(`${TMP}/debug.log`, debugLines.slice(-20000).join('\n') + '\n').catch(() => undefined)
}
let terminalName = ''
export const causeOf = (tmux: boolean, terminal: string): DrawCause =>
  tmux ? 'tmux' : /^(ghostty|kitty)$/.test(terminal) ? 'background' : 'terminal'

// The notice for a picture that couldn't draw, and the line Claude reads.
const GHOSTTY = 'https://ghostty.org/download'

export function cantDraw(cause: DrawCause, name: string, kind: 'picture' | 'video', id: string) {
  const what = kind === 'video' ? 'videos' : 'pictures'
  if (cause === 'tmux') return {
    title: `tmux is blocking ${what}`,
    text: `"${name}" is ready, but tmux stops ${what} from reaching the terminal. Add this line to ~/.tmux.conf, reload tmux, and ask Claude to show it again. Or open this chat outside tmux.`,
    command: 'set -g allow-passthrough on', label: 'Copy setting', action: 'copy_tmux_setting',
    claude: `tmux is blocking pictures, so the person saw a notice instead of ${name}. They can add "set -g allow-passthrough on" to ~/.tmux.conf or open the chat outside tmux.`,
  }
  if (cause === 'terminal') return {
    title: "Your terminal isn't supported by show-your-work",
    text: `"${name}" is ready, but this terminal can't draw ${what}. You need Ghostty to see them. Download it here, it's free and takes a minute:`,
    link: { href: GHOSTTY, then: 'Then press Copy command and paste it in Ghostty to open this chat there.' },
    command: `claude --resume${id ? ' ' + id : ''}`, label: 'Copy command', action: 'copy_resume_command',
    claude: `this terminal can't draw pictures, so the person saw a notice instead of ${name}. They need Ghostty to see it; it's free at ${GHOSTTY}.`,
  }
  return {
    title: `Can't show ${what} in a background session`,
    text: `"${name}" is ready, but this chat is running as a background session, and those can't draw ${what} in the terminal. Press Copy command and paste it in a normal Ghostty tab to reopen it there.`,
    command: resumeCommand(id), label: 'Copy command', action: 'copy_resume_command',
    claude: `this chat runs as a background session, which can't draw pictures, so the person saw a notice instead of ${name}. They can resume the chat in a normal terminal tab to see it.`,
  }
}

function Warning(ui: Ui, $: EngineInterface, site: string, shown: Shown, width: number) {
  const n = cantDraw(drawCause, shown.title, shown.frames ? 'video' : 'picture', sessionId)
  return NoticeBox(ui, $, width, { ...n, copy: n.command })
}

// The file behind a preview is gone (temp cleared, cache trimmed, or the
// original moved): say so in place of a blank box, with a prompt to paste.
export function expiredPrompt(shown: Shown): string {
  const file = shown.origin ?? shown.source ?? shown.path
  const kind = shown.frames ? 'video' : 'image'
  return `The ${kind} preview "${shown.title}" expired (${file} is gone). Please regenerate it and show it to me again with show_${kind}` +
    (shown.compare ? ', with the same compare' : '') + (shown.changes?.length ? ' and the same list of changes' : '') + '.'
}
function Expired(ui: Ui, $: EngineInterface, shown: Shown, width: number) {
  return NoticeBox(ui, $, width, {
    title: 'This preview has expired',
    text: `"${shown.title}" was cleared from the preview cache, and its file is no longer there. Copy the prompt and paste it to Claude to send it again.`,
    copy: expiredPrompt(shown), label: 'Copy prompt', action: 'copy_expired_prompt',
  })
}

// A failure, drawn in place of the picture: what happened, in plain words,
// and one button that copies what to paste back (a prompt, or a command).
function NoticeBox(ui: Ui, $: EngineInterface, width: number, n: { title: string; text: string; command?: string; copy: string; label: string; action: string; link?: { href: string; then: string } }) {
  const { Box, Text, Button, Link } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={2} paddingY={1} width={Math.max(40, Math.min(width, 96))}>
      <Text bold color="warning">⚠ {n.title}</Text>
      <Text wrap="wrap">{'\n'}{n.text}</Text>
      {n.link ? <Box marginTop={1}><Link href={n.link.href} /></Box> : null}
      {n.link ? <Text wrap="wrap">{'\n'}{n.link.then}</Text> : null}
      {/* A resume command is long and only ever pasted: the button copies it, unseen. */}
      {n.command && n.action !== 'copy_resume_command' ? <Box marginTop={1}><Text bold>{n.command}</Text></Box> : null}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button
          key={n.action}
          variant="primary"
          label={n.label}
          onPress={(press: { surface: 'terminal' }) =>
            act(n.action) || void $.ui.copy({ text: n.copy, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? (n.command ? 'Copied. Paste it in your terminal.' : 'Copied. Paste it to Claude.') : 'Could not copy'))
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
  const hasReport = !!(shown.change || shown.changes?.length || shown.summary?.length || shown.checks?.length || (one.isHistory && shown.history))
  const layout = layoutOf({ columns, rows: viewport?.rows ?? 40, isPane, hasReport })
  const isWide = layout.isWide
  const other = shown.compare ? (media === shown ? shown.compare : shown) : null
  for (const side of [media, other]) if (side) useSharpest(side)
  // A side short of pixels for its box gets a sharper copy, made in the background.
  if (cell) for (const side of [media, other]) if (side) sharpen($, side, pixelsFor(targetBox(side.width, side.height, layout, cell), cell, side.width / side.height))
  // This side's own box, and the frame it sits in: Original and Updated
  // share the larger of their two boxes, so switching never moves the layout
  // and each side draws whole at its own size, centred.
  const own = drawBox(media.width, media.height, layout, cell)
  const theirs = other ? drawBox(other.width, other.height, layout, cell) : own
  const box = { columns: Math.max(own.columns, theirs.columns), rows: Math.max(own.rows, theirs.rows) }
  // A new window or font size: the cell is measured again, and only a cell
  // that really changed redraws.
  const size = `${columns}x${viewport?.rows ?? 0}`
  if (cellFor !== size) {
    cellFor = size
    void $.clock.sleep(0).then(() => remeasure($)).then(isChanged => { if (isChanged) redraw($) }, () => undefined)
  }
  const isNarrow = box.columns < 60
  // Under the player the report takes at least a readable width, even beside a tall, thin picture.
  const below = hasReport && !isWide ? Math.max(box.columns, Math.min(layout.inner, 72)) : box.columns
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
  one.box = { columns: own.columns, rows: own.rows }
  await frameReady($, media, one.frame, site)
  if (await isGone($, plainAt(media, one.frame))) {
    one.timer?.cancel()
    one.timer = undefined
    return Expired(ui, $, shown, columns - 8)
  }
  const pic = await picFor($, plainAt(media, one.frame), own)
  probe($, site, viewKey(site), pic)
  if (one.isSplit && shown.pair && frames) return SplitView(ui, $, site, shown, columns, viewport?.rows ?? 40, isPane, prLink)

  const actions = Actions(ui, $, media, source, isNarrow)
  // The top corner opens it: the page it shows, else the file itself.
  // Only a web address opens as a page: a model's url could name an app, a
  // script or an option for `open`.
  const at = urlAt(media, frames ? one.frame / frames.fps : 0)
  const page = (at && /^https?:\/\/[^\s]+$/i.test(at) ? at : undefined) ?? (/\.html?$/i.test(source) ? source : undefined)
  const opener = (
    <Button
      key="page"
      plain
      label={page ? '↗ Open page' : '↗ View'}
      onPress={() =>
        act(page ? 'open_page' : 'open_file') || void $.process.run([openCommand(), page ?? source]).then(r =>
          $.ui.toast(r.exitCode === 0 ? `Opened ${(page ?? source.split('/').pop()!).slice(0, 60)}` : 'Could not open it'),
        )
      }
    />
  )

  // A tall, narrow picture still gets control rows wide enough to read on one
  // line each; the picture sits centred above them.
  // ...but never wider than the window has room for.
  // At least the controls' width, and the title bar's tabs with a little title.
  const controlsMin = Math.min(Math.max(CONTROLS_MIN, tabsWidth(shown) + 14), columns - 8)
  const rowWidth = Math.max(box.columns, controlsMin)
  const stage = (
    <Box flexDirection="column" width={rowWidth} alignItems="center">
      {Picture(ui, $, site, shown, media, own, pic, box)}
      {frames && Scrub(ui, $, site, media, rowWidth, shown)}
      <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap" width={rowWidth}>
        <Box flexDirection="row" columnGap={2}>
          {frames && <Button key="back" plain dimColor label="« 5s" onPress={() => act('skip_back') || seek($, site, media, one.frame / frames.fps - 5, shown)} />}
          {frames && <Button key="forward" plain dimColor label="5s »" onPress={() => act('skip_forward') || seek($, site, media, one.frame / frames.fps + 5, shown)} />}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {opener}
          {actions}
        </Box>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={(isWide ? Math.max(box.columns, controlsMin) + SIDE + 3 : Math.max(box.columns, controlsMin, below)) + 4}>
      {TitleBar(ui, $, site, shown, { checks })}
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
  // Never narrower than the controls, so the tabs and buttons always fit.
  const width = Math.max(box.columns, Math.min(Math.max(CONTROLS_MIN, tabsWidth(shown) + 14), columns - (isPane ? 6 : 10)))
  // The Updated side starts past the Original side and the gap between them.
  const pairPx = shown.pairWidth ?? shown.width * 2
  const half = Math.round((width * ((pairPx - PAIR_GAP) / 2 + PAIR_GAP)) / pairPx)
  const seconds = one.frame / shown.frames!.fps
  const change = changeAt(shown, seconds)
  const { fixed, broken } = checkDiff(shown.checks, before.checks)
  one.box = { columns: box.columns, rows: box.rows }
  await pairReady($, shown, Math.min(one.frame, pair.count - 1), site)
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
      {TitleBar(ui, $, site, shown, { width, pr: prLink })}
      {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
      <Box flexDirection="column" alignItems="center" width={width}>
        <Box flexDirection="row" marginTop={1} width={box.columns}>
          {head(before, 'Original', half)}
          {head(shown, 'Updated', box.columns - half)}
        </Box>
        {Image ? (
          <Image key="view-pair" source={'file' in pic.src ? { ...pic.src, generation: box.columns * 1000 + box.rows } : pic.src} columns={box.columns} rows={box.rows} alt="[original and updated, side by side]" />
        ) : (
          <Text dimColor>This surface cannot draw images.</Text>
        )}
      </Box>
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
        ) : (shown.checks?.length || before.checks?.length) ? (
          <Text dimColor>Same so far: both sides match up to {clock(seconds)}</Text>
        ) : null}
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
  description: 'Checks run: { name, ok, at? (seconds), url? }',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, ok: { type: 'boolean' }, at: { type: 'number' }, url: { type: 'string' } },
    required: ['name', 'ok'],
  },
}

const TOOL_INPUT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path' },
    title: { type: 'string', description: 'Short caption' },
    pr: { type: 'string', description: 'PR URL or number' },
    url: { type: 'string', description: 'The page shown; adds Open page' },
    changes: {
      type: 'array',
      description: 'What changed: { title, detail?, at? (seconds), url? }, in clip order',
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, at: { type: 'number' }, url: { type: 'string' } }, required: ['title'] },
    },
    summary: {
      type: 'array',
      description: 'QA in up to 3 lines: { label, ok, passed?, total? }',
      items: { type: 'object', properties: { label: { type: 'string' }, ok: { type: 'boolean' }, passed: { type: 'number' }, total: { type: 'number' } }, required: ['label', 'ok'] },
    },
    checks: CHECKS,
    compare: { type: 'string', description: 'Path to the before version' },
    compare_checks: { ...CHECKS, description: 'The same checks on the before side' },
    changes_title: { type: 'string', description: 'Heading for the changes list when not "What changed", e.g. "Video structure"' },
    previous: { type: 'string', description: '#id of the version this revises' },
    versions: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } }, required: ['path'] }, description: 'Earlier unshown versions of this work, oldest first: { path, note }' },
    label: { type: 'string', description: 'Name for this side if the user asks (default "Updated")' },
    compare_label: { type: 'string', description: 'Name for the before side if the user asks (default "Original")' },
  },
  required: ['path'],
}

// A picture needs no timed checks, play button or custom list heading.
const IMAGE_INPUT = {
  ...TOOL_INPUT,
  properties: Object.fromEntries(Object.entries(TOOL_INPUT.properties).filter(([k]) => !['checks', 'compare_checks', 'changes_title'].includes(k))),
}

// ── Usage stats ──────────────────────────────────────────────────────────

// Anonymous usage stats, sent to PostHog: what kind of thing happened and how
// often, under a random id made once per install. Never a file name, path,
// URL, title, prompt or anything typed. Off with SHOW_YOUR_WORK_TELEMETRY=0 or
// DO_NOT_TRACK=1, and nothing is sent while POSTHOG_KEY is empty.
const POSTHOG_HOST = 'https://us.i.posthog.com'
// The project API key: it can only add events, never read them, so it ships.
const POSTHOG_KEY = 'phc_mLGFguVcH3Tei4txwqXFPU4xBgFDKThEZncahTv3LS3W'
// Events wait here and go out together, at most once a minute and at exit.
const FLUSH_MS = 60_000
const MAX_QUEUED = 500

type Props = Record<string, string | number | boolean | null | undefined | Record<string, string | number | boolean | undefined>>
type Event = { event: string; properties: Props; timestamp: string }

let isOn = false
let installId = ''
let base: Props = {}
let queue: Event[] = []
let isFlushing = false

// A made-up name for an install, the same every time for one id, so profiles
// read as "Swift Otter" rather than a UUID. Nothing in it comes from the person.
const ADJECTIVES = ['Swift', 'Quiet', 'Brave', 'Clever', 'Sunny', 'Lucky', 'Bold', 'Calm', 'Eager', 'Gentle', 'Happy', 'Jolly', 'Keen', 'Lively', 'Mellow', 'Nimble', 'Plucky', 'Rapid', 'Snappy', 'Tidy', 'Witty', 'Zesty', 'Cosmic', 'Fuzzy']
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Badger', 'Gecko', 'Owl', 'Puffin', 'Raccoon', 'Seal', 'Tiger', 'Wombat', 'Yak', 'Bison', 'Crane', 'Dolphin', 'Ferret', 'Hedgehog', 'Lemur', 'Moose', 'Quokka']
export function nicknameOf(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const n = Math.floor(h / ADJECTIVES.length) % 1000

  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[Math.floor(h / 1000) % ANIMALS.length]} ${n}`
}

// An installed copy runs from Claude Code's plugin cache. One loaded from a
// folder (--plugin-dir) is someone working on the plugin: it sends nothing.
export const isInstalledCopy = (root: string) => /\/plugins\/cache\//.test(root)

// SHOW_YOUR_WORK_TELEMETRY=0, DO_NOT_TRACK=1 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: nothing is sent.
export const isStatsBlocked = (optOut?: string, dnt?: string, quiet?: string) =>
  /^(0|false|off|no)$/i.test(optOut ?? '') || /^(1|true)$/i.test(dnt ?? '') || !!quiet

async function startTelemetry($: EngineInterface, context: Props) {
  if (!POSTHOG_KEY || !isInstalledCopy($.plugin.root)) return
  const optOut = await $.env.get('SHOW_YOUR_WORK_TELEMETRY')
  const dnt = await $.env.get('DO_NOT_TRACK')
  const quiet = await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  if (isStatsBlocked(optOut, dnt, quiet)) return
  // Turned back on in the same session: the timer is already running.
  if (installId) return void (isOn = true)
  installId = String((await $.store.get('installId')) ?? '')
  const isNew = !installId
  if (isNew) {
    installId = crypto.randomUUID()
    await $.store.set('installId', installId)
  }
  isOn = true
  // Each install is one anonymous person, keyed by its random id: the profile
  // holds the setup it runs on, never anything about who uses it.
  // No location, ever: no IP is sent, and PostHog is told not to look one up.
  base = { ...context, $ip: null, $geoip_disable: true }
  const profile = { $set: { ...context, name: nicknameOf(installId) }, $set_once: { first_plugin_version: String(context.plugin_version ?? "") } }
  if (isNew) track('installed', profile)
  track('session_started', profile)
  $.clock.every(FLUSH_MS, () => void flush($))
}

// Counts and kinds only: callers pass no names, paths or text.
function track(event: string, properties: Props = {}) {
  if (!isOn) return
  if (queue.length >= MAX_QUEUED) queue.shift()
  queue.push({ event, properties: { ...base, ...properties }, timestamp: new Date().toISOString() })
}

async function flush($: EngineInterface) {
  if (!isOn || isFlushing || !queue.length) return
  isFlushing = true
  const batch = queue
  queue = []
  try {
    const r = await $.http.fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_KEY, batch: batch.map(e => ({ ...e, distinct_id: installId })) }),
    })
    // A refused batch is dropped, not retried: stats are never worth a backlog.
    if (!r.ok && r.status >= 500) queue = [...batch, ...queue].slice(-MAX_QUEUED)
  } catch {
    queue = [...batch, ...queue].slice(-MAX_QUEUED)
  } finally {
    isFlushing = false
  }
}

// ── Updates ──────────────────────────────────────────────────────────────

// Keeps the plugin current without the user turning on marketplace
// auto-update: once a day it asks GitHub for the version on the install's
// channel and, when it is newer, updates through Claude Code's own plugin
// commands, quietly. The new version runs from the next session.
//
// Two channels, one branch each: Stable releases follow `releases`, Latest
// follows `latest`. `main` is where work happens and nothing updates from
// it; an install still on it moves to its channel's branch. Moving means
// re-adding the marketplace at that branch and installing the plugin again
// (its store is kept), in a process of its own (see moveTo). Off with
// SHOW_YOUR_WORK_AUTO_UPDATE=0 or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, and
// never for an install pinned to a release tag.
const REPO = 'iamumeransari/claude-show-your-work'
const MARKETPLACE = 'iamumeransari'
const PLUGIN = 'show-your-work'
const SOURCE = `https://github.com/${REPO}.git`
export const BRANCHES = { stable: 'releases', latest: 'latest' } as const
type Branch = (typeof BRANCHES)[keyof typeof BRANCHES]
const manifestOn = (branch: string) => `https://raw.githubusercontent.com/${REPO}/${branch}/.claude-plugin/plugin.json`
const DAY_MS = 24 * 60 * 60 * 1000

// A version folder from before 0.6.0 in the plugin cache: this install was
// used before 0.6.0's welcome, so it was updated past it without seeing it.
export const hadVersionBefore06 = (names: string[]) => names.some(name => /^\d+\.\d+\.\d+$/.test(name) && isNewer('0.6.0', name))

// 1.10.0 is newer than 1.9.3; anything after a dash is ignored.
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map(n => Number(n) || 0)
  const a = parts(latest), b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }

  return false
}

// Where Claude Code's CLI usually is, when it isn't on the session's PATH.
const CLAUDE_BINARIES = ['claude', '.local/bin/claude', '.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
let claudeBinary = ''

// Runs Claude Code's CLI with the session's own environment (its PATH and
// CLAUDE_CONFIG_DIR), so it changes this install and no other.
async function claude($: EngineInterface, args: string[]) {
  const known = CLAUDE_BINARIES.map(b => (b.startsWith('.') ? `${home}/${b}` : b))
  const candidates = [...new Set([claudeBinary, ...known].filter(Boolean))]
  for (const bin of candidates) {
    const r = await $.process.run([bin, ...args], { timeoutMs: 120_000 }).catch(() => undefined)
    if (r) {
      claudeBinary = bin
      return r
    }
  }
  return undefined
}

function jsonOf<T>(text: string | undefined, fallback: T): T {
  try { return text ? (JSON.parse(text) as T) : fallback } catch { return fallback }
}

let pluginVersion = '0.0.0'
let statsContext: Props = {}

export async function checkForUpdate($: EngineInterface, current: string, branch: Branch = BRANCHES.stable) {
  const off = await $.env.get('SHOW_YOUR_WORK_AUTO_UPDATE')
  if (/^(0|false|off|no)$/i.test(off ?? '')) return
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return
  const now = await $.clock.now()
  if (now - Number((await $.store.get('updateCheckedAt')) ?? 0) < DAY_MS) return
  await $.store.set('updateCheckedAt', now)

  // No such branch yet: stay where it is.
  const r = await $.http.fetch(manifestOn(branch))
  if (!r.ok) return
  const latest = String(jsonOf<{ version?: string }>(r.text, {}).version ?? '')
  if (!latest) return

  // A marketplace read from a folder is someone working on the plugin: leave it.
  const markets = jsonOf<{ name: string; source: string; url?: string; ref?: string }[]>((await claude($, ['plugin', 'marketplace', 'list', '--json']))?.stdout, [])
  const market = markets.find(m => m.name === MARKETPLACE)
  if (!market || market.source === 'directory') return
  // Added with #v0.5.14 or another ref: the user chose that version.
  const ref = market.ref ?? 'main'
  if (ref !== 'main' && !Object.values(BRANCHES).includes(ref as Branch)) return
  if (ref !== branch) return moveTo($, branch, market)
  if (!isNewer(latest, current)) return
  const plugins = jsonOf<{ id: string; scope?: string; version?: string }[]>((await claude($, ['plugin', 'list', '--json']))?.stdout, [])
  const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`)
  if (!installed) return
  // Already fetched by an earlier check; it runs from the next session.
  if (installed.version && !isNewer(latest, installed.version)) return

  await claude($, ['plugin', 'marketplace', 'update', MARKETPLACE])
  const done = await claude($, ['plugin', 'update', `${PLUGIN}@${MARKETPLACE}`, '--scope', installed.scope ?? 'user'])
  if (done?.exitCode !== 0) {
    track('update_failed', { from: current, to: latest })
    return
  }
  track('update_installed', { from: current, to: latest })
}

// Puts the install on another channel's branch: the marketplace again at that
// branch, then the plugin from it. The steps run in a process of their own,
// outside the session, so quitting Claude Code halfway can't leave the plugin
// uninstalled; when the branch can't be added or its plugin won't install,
// the old source and the plugin go back, a second time if the first fails.
export const MOVE_SH = [
  'exec </dev/null >/dev/null 2>&1',
  'c=$1 url=$2 branch=$3 old=$4 scope=$5 market=$6 id=$7',
  '"$c" plugin marketplace remove "$market" || exit 0',
  '"$c" plugin marketplace add "$url#$branch" && "$c" plugin install "$id" --scope "$scope" && exit 0',
  '"$c" plugin marketplace remove "$market"',
  'for try in 1 2; do "$c" plugin marketplace add "$old"; "$c" plugin install "$id" --scope "$scope" && exit 0; done',
  'exit 1',
].join('\n')
// Starts a script in a session of its own, so it outlives this one.
const DETACH = ['perl', '-MPOSIX', '-e', 'fork and exit; POSIX::setsid(); exec @ARGV']
async function moveTo($: EngineInterface, branch: Branch, market: { url?: string; ref?: string }) {
  const plugins = jsonOf<{ id: string; scope?: string }[]>((await claude($, ['plugin', 'list', '--json']))?.stdout, [])
  const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`)
  if (!installed || !claudeBinary) return
  const url = market.url ?? SOURCE
  const old = market.ref ? `${url}#${market.ref}` : url
  track('channel_move', { from: market.ref ?? 'main', to: branch })
  await $.process.run([...DETACH, 'sh', '-c', MOVE_SH, 'move', claudeBinary, url, branch, old, installed.scope ?? 'user', MARKETPLACE, `${PLUGIN}@${MARKETPLACE}`]).catch(() => undefined)
}

// ── Settings and welcome ─────────────────────────────────────────────────

// The switches, kept in the plugin's store (a /config row would reload the
// plugin on every change). The environment variables still turn updates and
// usage counts off whatever these say.
export const SETTINGS = [
  { field: 'stable_updates', title: 'Updates', options: ['Stable releases', 'Latest'], text: 'Automatically install plugin updates from GitHub' },
  { field: 'usage_stats', title: 'Usage data', options: ['Share anonymously', "Don't share"], text: 'Helps fix bugs and improve the product experience. No sensitive data is ever shared' },
] as const
type Field = (typeof SETTINGS)[number]['field']
// Each switch is true on its first option, the default.
const settings: Record<Field, boolean> = { stable_updates: true, usage_stats: true }
const WELCOME = 'show-your-work-welcome'
// The settings pane's redraws.
// The viewport is the whole screen; a docked pane is narrower and shorter, so
// it sizes to its own body.
type PaneProps = { bodyColumns?: number; bodyRows?: number; scroll?: { bodyRows?: number } }
export const paneSize = (viewport: { columns: number; rows: number } | undefined, props: PaneProps) => {
  if (!viewport) return viewport
  const rows = props.bodyRows ?? props.scroll?.bodyRows
  return { columns: props.bodyColumns || viewport.columns, rows: rows || viewport.rows }
}

const welcome = atom({ plugin: 'show-your-work', key: 'welcome' } as const, 0)

// A no to usage data given before these settings (0.5.12's question, 0.5.16's command) stays a no.
// Updates are on for everyone: fixes have to reach every install.
export const earlierNo = (consent: unknown, statsOff: unknown, updatesOff: unknown) => {
  const asked = consent && typeof consent === 'object' ? consent as { stats?: unknown; updates?: unknown } : {}
  return { isStatsOff: statsOff === true || asked.stats === false, isUpdatesOff: updatesOff === true || asked.updates === false }
}

async function loadSettings($: EngineInterface) {
  const saved = ((await $.store.get('settings')) ?? {}) as Partial<Record<Field, unknown>>
  if (typeof saved.usage_stats !== 'boolean' && earlierNo(await $.store.get('consent'), await $.store.get('statsOff'), null).isStatsOff) settings.usage_stats = false
  for (const { field } of SETTINGS) if (typeof saved[field] === 'boolean') settings[field] = saved[field] as boolean
}

async function switchSetting($: EngineInterface, field: Field, value: boolean) {
  // The saved choices, not this module's copy: a reload resets the copy.
  await loadSettings($)
  settings[field] = value
  act(`setting_${field}_${value ? 'first' : 'second'}`)
  await $.store.set('settings', { ...settings })
  if (field === 'usage_stats' && !value) isOn = false
  if (field === 'usage_stats' && value && isWelcomed) await startTelemetry($, statsContext)
  // A new channel is followed now.
  if (field === 'stable_updates' && isWelcomed) {
    await $.store.set('updateCheckedAt', 0)
    void checkForUpdate($, pluginVersion, value ? BRANCHES.stable : BRANCHES.latest).catch(() => undefined)
  }
  await update($, welcome, n => n + 1)
}

// Updates and usage counts wait for the welcome on a first run, so a switch
// turned off there is off before anything is sent.
async function startBackground($: EngineInterface) {
  if (hasStarted) return
  hasStarted = true
  if (settings.usage_stats) await startTelemetry($, statsContext)
  await checkForUpdate($, pluginVersion, settings.stable_updates ? BRANCHES.stable : BRANCHES.latest)
}

// The first run (see 'toured'): the plugin runs /show-your-work once, and its output row
// in the chat draws the welcome. That run answers with WELCOME_TEXT, which is
// how its row is told from the person's own /show-your-work.
const WELCOME_TEXT = 'show-your-work is installed and ready.'
async function openWelcome($: EngineInterface) {
  await prepareSplash($).catch(() => undefined)
  await finishWelcome($)
  await openTour($)
}

// /show-your-work: the switches, in a pane.
async function openSettings($: EngineInterface) {
  await $.ui.open({ id: WELCOME, title: 'Settings', focus: true, closeOnEscape: true, holdToasts: true, rows: 10, columns: 70 })
  await update($, welcome, n => n + 1)
}

let isWelcomed = false
let hasStarted = false
async function finishWelcome($: EngineInterface) {
  if (isWelcomed) return
  isWelcomed = true
  await $.store.set('toured', true)
  await startBackground($)
}

// A five-second recording of a form being tested, played in the real
// player with its changes and checks; the picture of one without ffmpeg.
// The welcome's opening: show-your-work rising over a night sky, played once
// as a picture with no controls, then held on its last frame. A still
// without ffmpeg.
let splash: Shown | null = null
let hasPlayedSplash = false
async function prepareSplash($: EngineInterface) {
  const opened = await prepare($, `${$.plugin.root}/assets/splash.mp4`, 'show-your-work')
    .catch(() => prepare($, `${$.plugin.root}/assets/splash.jpg`, 'show-your-work'))
    .catch(() => null)
  // The player's side list: what the plugin does, and real checks of this
  // setup, ticking as the opening plays.
  splash = opened && {
    ...opened,
    changesTitle: 'What it does',
    changes: [
      { title: 'Installed', at: 1.8 },
      { title: 'Everything Claude can show you', at: 5.0 },
      { title: 'Claude shows what it builds', at: 15.7 },
    ],
    checks: [
      { name: 'This terminal draws pictures', ok: canImage, at: 2.2 },
      { name: 'ffmpeg plays videos', ok: !!opened.frames, at: 5.5 },
      { name: 'Plugin installed', ok: true, at: 16.0 },
    ],
  }
  await update($, welcome, n => n + 1)
  redraw($)
}

// /show-your-work's pane: the switches, and the way back into the tour.
function Settings(ui: Ui, $: EngineInterface) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" paddingX={2} paddingBottom={1}>
      <Box flexDirection="row" columnGap={2} marginBottom={1}>
        <Button key="close" label="✕ Close" onPress={() => void $.ui.close({ id: WELCOME })} />
        <Button key="tour" label="Take a tour" onPress={() => { act('tour_from_settings'); void $.ui.close({ id: WELCOME }).then(() => openTour($)) }} />
      </Box>
      <Box marginBottom={1}><Text bold>Show Your Work Settings</Text></Box>
      {SettingRows(ui, $)}
    </Box>
  )
}

// Quiet: plain words, the choice marked ● and the other ○, in columns that
// line up, so choosing moves nothing.
function SettingRows(ui: Ui, $: EngineInterface) {
  const { Box, Text, Button } = ui
  const first = Math.max(...SETTINGS.map(s => s.options[0].length)) + 4
  return (
    <Box flexDirection="column">
      {SETTINGS.map(s => (
        <Box key={`row-${s.field}`} flexDirection="row">
          <Box width={24} flexShrink={0}><Text dimColor>{s.title}</Text></Box>
          {s.options.map((label, k) => {
            const isChosen = settings[s.field] === (k === 0)
            return (
              <Box key={`slot-${s.field}-${k}`} width={k === 0 ? first : undefined} flexShrink={0}>
                {/* The default in green, the other in orange; the one not chosen
                    dim. Before Claude Code 2.1.295 a Button holds only its label. */}
                {canColourButtons ? (
                  <Button key={`${s.field}-${k}`} plain label={`${isChosen ? '●' : '○'} ${label}`} onPress={() => void switchSetting($, s.field, k === 0)}>
                    <Text color={k === 0 ? 'success' : 'claude'} dimColor={!isChosen}>{`${isChosen ? '●' : '○'} ${label}`}</Text>
                  </Button>
                ) : (
                  <Button key={`${s.field}-${k}`} plain {...(isChosen ? {} : { dimColor: true })} label={`${isChosen ? '●' : '○'} ${label}`} onPress={() => void switchSetting($, s.field, k === 0)} />
                )}
              </Box>
            )
          })}
        </Box>
      ))}
      <Box marginTop={1}><Text dimColor>Usage data is anonymous and helps fix bugs and improve the product experience. No sensitive data is ever shared.</Text></Box>
    </Box>
  )
}

// The welcome row: the opening in the real player, with its side list, then
// what to ask and one quiet line about updates and usage counts.
async function Opening($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], site: string, viewport?: { columns: number; rows: number }) {
  const { Box, Text } = $.ui.resolve(e) as Ui
  let view = null
  // Where pictures can't draw, the heading alone: a warning has no place here.
  if (splash && canImage) {
    // Plays by itself once, as a video Claude shows does.
    if (!hasPlayedSplash) {
      hasPlayedSplash = true
      freshCalls.add(site)
    }
    view = await Viewer($, e, atStep(splash, site), site, false, viewport)
  }
  return (
    <Box flexDirection="column" rowGap={1}>
      {view ?? <Text bold color="claude">✦ show-your-work is installed and ready</Text>}
      <Box flexDirection="column">
        <Text>Claude now shows you pictures and videos right here in the chat. Try asking Claude to create something and show it to you in the chat, as an image or a recording.</Text>
        <Text dimColor>It keeps itself updated and sends anonymous usage counts. Change this with /show-your-work, and see every feature with /show-your-work tour.</Text>
      </Box>
    </Box>
  )
}

// ── Tour ─────────────────────────────────────────────────────────────────

// A walk through the player on the launch film's demos: the opening, a recording with
// its report, the same recording against the broken version, a screenshot's
// history, then the commands and switches. Opens by itself on a fresh
// install; /show-your-work tour, or the button in the settings, opens it again.
const TOUR = 'show-your-work-tour'
// The tour is a message in the chat, drawn by the output row of
// /show-your-work tour (TOUR_TEXT marks it): it lays out at the chat's full
// width at any window size. tourSite is the live row; an older one shrinks to
// a line.
const TOUR_TEXT = 'show-your-work tour.'
let tourSite = ''
let isTourPending = false
let isTourDone = false
// Each stop points at one real control (spot) with one short line (tag), and
// is done when the person uses it (goal: the act() name its button fires).
type Spot = 'play' | 'changes' | 'tabs' | 'history'
type Stop = { title: string; tag: string; spot?: Spot; goal?: string; media?: 'splash' | 'recording' | 'compare' | 'history' }
export const STOPS: Stop[] = [
  { title: 'Claude shows you what it builds', tag: 'Press ▶ Play', spot: 'play', goal: 'play', media: 'splash' },
  { title: 'Jump to any change', tag: 'Click a change to jump to that moment', spot: 'changes', goal: 'change_jump', media: 'recording' },
  { title: 'See before and after', tag: 'Press Original to see it before the change', spot: 'tabs', goal: 'original', media: 'compare' },
  { title: 'Every version is kept', tag: 'Open History, then pick a version', spot: 'history', goal: 'version_pick', media: 'history' },
  { title: "You're set", tag: 'Try asking Claude to create something and show it to you in the chat, as an image or a recording.' },
]
let tourStop = 0
let isStopDone = false

// A button press, heard: when it is what the stop asked for, it ticks; the
// person moves on with Next when they're ready.
function tourHeard($: EngineInterface, action: string) {
  const s = STOPS[tourStop]
  if (!tourSite || isTourDone || isStopDone || !s?.goal || s.goal !== action) return
  isStopDone = true
  void update($, welcome, n => n + 1)
}

// The one line above the control a stop points at, in the tour's row only.
const tourMedia: { recording?: Shown | null; compare?: Shown | null; history?: Shown | null } = {}

// The demo's media, read once, all from the launch film: the new-trip form
// tested with its changes and checks, the Tern hero before and after its
// trip card, and the hero's history from four directions to every width.
async function prepareTour($: EngineInterface) {
  const dir = `${$.plugin.root}/assets/tour`
  if (tourMedia.recording === undefined) {
    tourMedia.recording = await (async () => {
      const clip = await prepare($, `${dir}/trip-form.mp4`, 'New trip form')
      const lead = clip.frames?.lead ?? 0
      const at = (s: number) => Math.max(0, s - lead)
      return {
        ...clip,
        // Where each step lands in the recording (its QA run, 1.3 s behind the log).
        changes: [
          { title: 'Dates pick a range, nights in the summary', at: at(5.25) },
          { title: 'Invalid emails rejected with a message', at: at(6.85) },
          { title: 'Invites become chips', at: at(9.1) },
          { title: 'Create trip opens the trip', at: at(10.5) },
        ],
        checks: [
          { name: 'Dates pick a range', ok: true, at: at(5.25) },
          { name: 'Bad emails get a message', ok: true, at: at(6.85) },
          { name: 'Invites become chips', ok: true, at: at(9.1) },
          { name: 'Create trip opens the trip', ok: true, at: at(10.7) },
          { name: 'Labels for screen readers', ok: true, at: at(11.2) },
        ],
        summary: [
          { label: 'Trip form works end to end', ok: true, passed: 4, total: 4 },
          { label: 'Labels for screen readers', ok: true, passed: 1, total: 1 },
        ],
      } as Shown
    })().catch(() => prepare($, `${dir}/hero.jpg`, 'Tern homepage').catch(() => null))
  }
  if (tourMedia.compare === undefined) {
    tourMedia.compare = await (async () => ({
      ...(await prepare($, `${dir}/hero.jpg`, 'Tern homepage')),
      changes: [{ title: 'Trip card beside the headline' }, { title: 'Friends and trip count under the button' }],
      compare: await prepare($, `${dir}/direction-b.jpg`, 'Original'),
    }) as Shown)().catch(() => null)
  }
  if (tourMedia.history === undefined) {
    tourMedia.history = await (async () => {
      const hero = `${dir}/hero.jpg`
      return {
        ...(await prepare($, `${dir}/breakpoints.jpg`, 'Tern homepage')),
        changes: [{ title: 'Desktop, tablet and phone' }],
        note: 'Desktop, tablet and phone',
        compare: await preparedOf($, hero),
        history: [
          { path: `${dir}/concepts.jpg`, note: 'Four directions' },
          { path: `${dir}/direction-b.jpg`, note: 'Direction B, full size' },
          { path: hero, note: 'Trip card beside the headline' },
        ],
        historyAt: 2,
      } as Shown
    })().catch(() => null)
  }
  await update($, welcome, n => n + 1)
}

// Runs /show-your-work tour, whose output row draws the tour.
async function openTour($: EngineInterface) {
  // A plugin's own run never reaches its own command.run hook: the tour starts
  // here, and its row is drawn by the args it carries.
  startTour($)
  await $.command.run({ command: PLUGIN, args: 'tour' }).catch(() => undefined)
}

// What /show-your-work tour does before its row draws: the first stop, and
// the demo's media read in the background.
function startTour($: EngineInterface) {
  act('tour_open')
  isTourPending = true
  isTourDone = false
  tourStop = 0
  void (async () => {
    if (!splash) await prepareSplash($).catch(() => undefined)
    await prepareTour($)
  })().catch(() => undefined)
}

// Each stop starts its player fresh; a video starts playing by itself.
function goToStop($: EngineInterface, to: number) {
  stop($, tourSite)
  players.delete(tourSite)
  tourStop = Math.max(0, Math.min(STOPS.length - 1, to))
  isStopDone = false
  const media = mediaOf(STOPS[tourStop]!)
  if (media?.frames && STOPS[tourStop]!.goal !== 'play') void $.clock.sleep(400).then(() => { if (mediaOf(STOPS[tourStop]!) === media) play($, tourSite, media, media) }, () => undefined)
  void update($, welcome, n => n + 1)
}

const mediaOf = (s: Stop) => (s.media === 'splash' ? splash : s.media ? tourMedia[s.media] : null) ?? null

async function finishTour($: EngineInterface, isSkip: boolean) {
  act(isSkip ? `tour_skip_${tourStop}` : 'tour_done')
  stop($, tourSite)
  isTourDone = true
  await update($, welcome, n => n + 1)
}

async function Tour($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], viewport?: { columns: number; rows: number }) {
  const ui = $.ui.resolve(e) as Ui
  const { Box, Text, Button } = ui
  const at = tourStop
  const s = STOPS[at]!
  const isLast = at === STOPS.length - 1
  const media = mediaOf(s)
  if (isTourDone) return <Text dimColor>✓ Tour finished. /show-your-work tour shows it again.</Text>
  const room = { columns: viewport?.columns ?? 100, rows: Math.max(24, viewport?.rows ?? 40) }
  let view = null
  if (media) view = await Viewer($, e, atStep(media, tourSite), tourSite, false, room)
  else if (s.media) view = <Text dimColor>Loading the demo…</Text>

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {STOPS.map((_, i) => <Text key={`dot-${i}`} color={i === at ? 'claude' : undefined} dimColor={i !== at}>{i === at ? '● ' : '○ '}</Text>)}
          <Text dimColor>{`${at + 1} of ${STOPS.length}`}</Text>
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>{s.title}{isStopDone ? <Text color="success">  ✓</Text> : null}</Text>
        {/* Every stop's instruction, here under its title; kept, dim, once done. */}
        {s.spot ? <Text color="claude" bold dimColor={isStopDone}>{s.tag}</Text> : <Text>{s.tag}</Text>}
      </Box>
      {view}
      {/* Boxed like the player: a title bar, then the choices. */}
      {isLast && (
        <Box key="settings-box" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={Math.min((viewport?.columns ?? 100) - 2, 100)}>
          <Text bold>Settings</Text>
          <Box marginTop={1}>{SettingRows(ui, $)}</Box>
        </Box>
      )}
      <Box flexDirection="row" columnGap={2}>
        {at > 0 && <Button key="prev" label="‹ Back" onPress={() => { act(`tour_back_${at}`); goToStop($, at - 1) }} />}
        {isLast
          ? <Button key="done" variant="primary" label="Done" onPress={() => void finishTour($, false)} />
          : <Button key="next" variant="primary" label="Next ›" onPress={() => { act(`tour_next_${at}`); goToStop($, at + 1) }} />}
        {!isLast && <Button key="skip" plain dimColor label="Skip tour" onPress={() => void finishTour($, true)} />}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = started.cwd
    setup = null
    await setUp($)
    sessionId = await $.session.id().catch(() => '')
    hasVideoTools = false
    await loadSettings($)
    void (async () => {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
      pluginVersion = manifest.version ?? '0.0.0'
      const program = (await $.env.get('TERM_PROGRAM')) ?? ''
      const term = (await $.env.get('TERM')) ?? ''
      const terminal = /ghostty/i.test(program + term) ? 'ghostty' : /kitty/i.test(term) ? 'kitty' : program.toLowerCase() || 'other'
      terminalName = terminal
      inTmux = !!(await $.env.get('TMUX')) || /^tmux/i.test(term)
      isDebug = /^(1|true|on|yes)$/i.test((await $.env.get('SHOW_YOUR_WORK_DEBUG')) ?? '')
      if (isDebug) $.clock.every(1000, () => void flushDebug($))
      // tmux with passthrough off never lets a picture through: known before the first one.
      if (inTmux) {
        const pass = await $.process.run(['tmux', 'show', '-gv', 'allow-passthrough']).catch(() => null)
        if (pass && pass.exitCode === 0 && /^off$/i.test(pass.stdout.trim())) {
          canImage = false
          probed = true
          drawCause = 'tmux'
        }
      }
      statsContext = {
        plugin_version: pluginVersion,
        claude_code_version: (await $.session.version().catch(() => ({ base: '' }))).base ?? '',
        terminal,
        has_ffmpeg: await exists($, ffmpeg),
        os: isMac ? 'macos' : 'linux',
      }
      // Every install sees the welcome and tour once, an update included:
      // installs from before 0.6.2 never had one. 0.6.0 stored 'welcomed' both
      // when it showed the welcome and when it skipped it for an update; an
      // older version's folder still beside this one marks the update.
      isWelcomed = !!(await $.store.get('toured'))
      if (!isWelcomed && await $.store.get('welcomed')) {
        const versions = await $.fs.list($.plugin.root.replace(/\/+$/, '').replace(/\/[^/]+$/, '')).catch(() => [])
        if (!hadVersionBefore06(versions.map(f => f.name))) {
          isWelcomed = true
          await $.store.set('toured', true)
        }
      }
      // An update keeps what it already ran: its updates and usage counts start
      // now, and only a fresh install waits for the welcome.
      const isUpdate = (await Promise.all(['welcomed', 'installId', 'updateCheckedAt'].map(key => $.store.get(key)))).some(value => value !== undefined && value !== null)
      if (!isWelcomed && isUpdate) await startBackground($)
      if (isWelcomed) await startBackground($)
      else await openWelcome($)
    })().catch(() => undefined)
    // Frames and converted pictures a week old go; a window that scrolls back
    // into view cuts its frames again from the source.
    void $.process.run(['sh', '-c', CLEAN_SH, TMP]).then(() => trimFrames($))
    await $.command.register({
      name: 'show-your-work',
      description: 'Settings for show-your-work, or the tour: /show-your-work tour',
      argumentHint: '[tour]',
    })
    await $.command.register({
      name: 'img',
      description: 'Show an image or video in the chat: /img <path>',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        "Shows an image file to the user, inline in their terminal. Accepts PNG, JPEG, WebP, GIF and TIFF.\n\n" +
        'Use it without being asked whenever you have made or changed something visual, before you say the work is done: screenshot a page or component with headless Playwright, or show a design concept, chart, slide or generated image. ' +
        "Do this instead of asking the user to open a file or a localhost URL. Don't use it when nothing visual changed.\n\n" +
        'When the image shows work you changed, also pass `changes` (what you changed, a few words each) and `compare` (an image of the same view from before the change), so the user can switch between Original, Updated and Compare. ' +
        'Pass `summary` only for checks you actually ran. When you show a new version of something you showed earlier, pass `previous` with its #id so both stay in the same history.\n\n' +
        "The image goes to the user's screen, not to you. Read the file yourself only if you need to check it.\n\n" +
        SCRATCH_NOTE,
      inputSchema: IMAGE_INPUT,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_video',
      description:
        "Plays a video file to the user, inline in their terminal, in a player that starts on its own. Accepts MP4, MOV, WebM and GIF.\n\n" +
        'Use it without being asked to show recordings: after building or fixing an interactive feature, record a headless Playwright run that clicks through it and play that, rather than asking the user to try it themselves. Also use it for animations and for ad or film cuts you have made.\n\n' +
        'When the video shows work you changed, pass `changes`, each with `at` (the second it appears), and `checks` for what you tested, also with `at`. ' +
        'For a fix, record the same steps on the old version and pass that file as `compare` with its own `compare_checks`; the two play side by side, in sync. ' +
        'Pass `summary` only for checks you actually ran, and `previous` with an earlier #id when this is a new version of something you showed.\n\n' +
        'Keep clips short: they are played as frames, at most 900 at up to 12 per second. You do not see the video.\n\n' +
        SCRATCH_NOTE,
      inputSchema: TOOL_INPUT,
      isDeferred: false,
    })

    return started
  })

  // While pictures draw, Claude is told up front that it can show its work,
  // so it does so without being asked. Once a draw has failed, every later
  // turn knows instead: what was "shown" was a notice, not the picture.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.some(t => TOOLS.includes(t))) return composed
    if (canImage) {
      return {
        sections: [...composed.sections, {
          id: 'show-your-work:show-visual-work', scope: 'session',
          text: "This terminal shows pictures and videos inline. After visual work, screenshot or record it and show it with show_image or show_video before you say you're done, instead of telling the user to open a file or localhost. For a UI fix, show before and after.",
        }],
      }
    }
    const why = cantDraw(drawCause, 'it', 'picture', sessionId).claude.replace(/, so the person saw a notice instead of it\./, '.')
    return {
      sections: [...composed.sections, {
        id: 'show-your-work:cannot-draw', scope: 'session',
        text: `show-your-work: pictures and videos can't draw in this session (${why}) Anything shown with show_image or show_video was not seen: the person saw a notice instead. Don't say they saw it.`,
      }],
    }
  })

  on('session.end', async ($, e, next) => {
    await flush($).catch(() => undefined)

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    // Sending a message puts the settings away.
    if (e.origin?.kind !== 'plugin') void $.ui.panes().then(panes => { if (panes.some(p => p.id === WELCOME)) return $.ui.close({ id: WELCOME }) }).catch(() => undefined)
    pastedNames = (e.attachments ?? []).filter(a => a.type === 'image' && a.filename).map(a => a.filename!)

    return next(e)
  })

  on('command.run', { command: 'img' }, async ($, e) => {
    await setUp($)
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
      // Drawn in the chat, in this command's own row, by the CommandOutput hook.
      const id = keyOf(`${arg}|${await $.clock.now()}`).slice(0, 10)
      shownById.set(id, shown)

      track('img_command', { kind: shown.frames ? 'video' : 'image' })
      return { text: `Showing ${shown.title}.\n${MARK}#${id}` }
    } catch (err) {
      const n = noticeOf(err, expand(arg, cwd, home), home)
      track('show_failed', { from: 'img_command', reason: REASONS[n.kind] })
      return { text: n.message }
    }
  })

  on('tool.call', { tool: /^mcp__show-your-work__show_(image|video)$/ }, async ($, e) => {
    freshCalls.add(e.tool_use_id)
    const input = { ...e } as unknown as {
      path?: string; title?: string; change?: string; pr?: string; changes?: KeyChange[]; summary?: Summary[]; url?: string; checks?: Check[]
      compare?: string; compare_checks?: Check[]; label?: string; compare_label?: string; overlay?: Overlay; versions?: unknown; previous?: string; changes_title?: string
    }
    if (!input.path) return { deny: 'A path is needed.' }
    await setUp($)
    // The history's copy of a file that then can't be shown goes again.
    let copied = ''
    try {
      input.path = await locate($, input.path)
      if (input.compare) input.compare = await locate($, input.compare)
      const note = noteOf(input.changes, input.change, input.title)
      const parent = handleOf(input.previous)
      // Only pictures and videos are copied into the history: never a key or
      // a config file a model was talked into naming.
      if (!MEDIA.test(input.path)) throw new Error(`not an image: ${input.path}`)
      const kept = await storeVersion($, input.path, note, input.title, parent)
        .catch(() => ({ real: input.path!, copy: input.path!, id: '', chain: [] as { path: string; note?: string; id: string }[], missing: undefined as string | undefined }))
      if (kept.copy !== kept.real) copied = kept.copy
      // Every earlier version: the ones handed in, then the ones shown before.
      const given = await Promise.all(versionsOf(input.versions).map(async v => ({ ...v, path: await locate($, v.path) })))
      const earlier = [...given, ...kept.chain.filter(k => !given.some(g => g.path === k.path))]
      const compare = input.compare ?? earlier.at(-1)?.path
      const shown: Shown = {
        ...(await prepare($, kept.copy, input.title ?? input.path.split('/').pop(), await identityOf($, input.path))),
        origin: kept.real,
        change: input.change,
        pr: input.pr,
        url: input.url,
        checks: input.checks,
        changes: timesThatMean(input.changes, VIDEO.test(input.path)),
        summary: input.summary,
        label: input.label,
        overlay: input.overlay,
        note,
        ...(input.changes_title ? { changesTitle: String(input.changes_title).slice(0, 28) } : {}),
      }
      const lead = shown.frames?.lead ?? 0
      shown.checks = shiftTimes(shown.checks, lead)
      shown.changes = shiftTimes(shown.changes, lead)
      if (compare) {
        const label = input.compare_label
        shown.compare = {
          ...(input.compare ? await prepare($, compare, label ?? 'Original') : await preparedOf($, compare)),
          label,
          checks: input.compare_checks,
        }
        shown.compare.checks = shiftTimes(shown.compare.checks, shown.compare.frames?.lead ?? 0)
        // Pictures step back through every earlier version; a clip has only
        // Original and Updated.
        if (!shown.frames && earlier.length > 1) {
          shown.history = input.compare && !earlier.some(v => v.path === compare) ? [{ path: compare }, ...earlier] : earlier
          shown.historyAt = shown.history.findIndex(v => v.path === compare)
          remember(compare, shown.compare)
        }
        if (shown.frames && shown.compare.frames) Object.assign(shown, (await preparePair($, shown.compare, shown)) ?? {})
      }
      if (!shown.frames && kept.copy !== kept.real)
        remember(kept.copy, { kind: shown.kind, path: shown.path, source: shown.source, width: shown.width, height: shown.height, title: 'Original', generation: shown.generation })
      const what = shown.frames ? `video, ${clock(shown.frames.duration)}` : `${shown.sourceWidth ?? shown.width}×${shown.sourceHeight ?? shown.height}`
      const checks = [...(shown.checks ?? []), ...(shown.compare?.checks ?? [])]
      track(shown.frames ? 'video_shown' : 'image_shown', {
        format: (input.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'none').toLowerCase().slice(0, 5),
        ...(shown.frames ? { duration: Math.round(shown.frames.duration * 10) / 10, frames: shown.frames.count } : {}),
        has_compare: !!shown.compare,
        is_side_by_side: !!shown.pair,
        is_revision: !!input.previous,
        versions: shown.history?.length ?? 0,
        changes: shown.changes?.length ?? 0,
        has_custom_changes_title: !!input.changes_title,
        summary_lines: shown.summary?.length ?? 0,
        summary_ok: shown.summary ? shown.summary.every(l => l.ok) : undefined,
        checks: checks.length,
        checks_failed: checks.filter(c => !c.ok).length,
        has_url: !!input.url,
        has_pr: !!input.pr,
      })

      const handle = kept.id ? ` #${kept.id}${kept.chain.length ? `, version ${kept.chain.length + 1} after #${kept.chain.at(-1)!.id}` : ''}.` : ''
      const hint = (kept.missing ? ` #${kept.missing} wasn't found, so this has no history.` : '') + handle
      const opening = canImage
        ? `Shown: ${shown.title} (${what}).`
        : `Not shown: ${cantDraw(drawCause, shown.title, shown.frames ? 'video' : 'picture', sessionId).claude} Don't say it was shown.`
      // Claude gets one short line; the drawing data stays out of its context.
      let mark = JSON.stringify(shown)
      if (kept.id) {
        const saved = await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${kept.id}.shown`, mark]).catch(() => null)
        if (saved && saved.exitCode === 0) {
          shownById.set(kept.id, shown)
          mark = `#${kept.id}`
        }
      }
      return { result: `${opening}${hint}\n${MARK}${mark}` }
    } catch (err) {
      if (copied) void $.process.run(['rm', '-f', '--', copied, copied.replace(/\.[^./]+$/, '.json')]).catch(() => undefined)
      const n = noticeOf(err, expand(input.path ?? '', cwd, home), home)
      notices.set(e.tool_use_id, n)
      track('show_failed', { from: String((e as { tool?: string }).tool ?? '').endsWith('video') ? 'show_video' : 'show_image', reason: REASONS[n.kind] })
      return { deny: `show-your-work: ${n.message}` }
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
    if (!TOOLS.includes(props.tool)) return next(e)
    if (props.isErrored) {
      const n = notices.get((props as { tool_use_id?: string }).tool_use_id ?? '') ??
        (textOf(props.output).includes(NO_FFMPEG) ? noticeOf(new Error(NO_FFMPEG), '') : undefined)
      if (!n) return next(e)
      return NoticeBox($.ui.resolve(e) as Ui, $, (e.viewport?.columns ?? 100) - 8, { ...n, copy: n.prompt, label: 'Copy prompt', action: `copy_${n.kind}_prompt` })
    }
    // Scrolled out of view: stop playing, and don't start there.
    const one = player(e.requestId)
    if (props.onScreen === null) {
      if (one.timer) stop($, e.requestId)
      one.hasAutoplayed = true
      one.wasAway = true
    } else if (one.wasAway && props.onScreen) {
      // Back in view: draw it fresh. The terminal may have dropped the picture
      // and the cache its frame; the redraw decodes the frame again if needed.
      one.wasAway = false
      versions.set(e.requestId, (versions.get(e.requestId) ?? 0) + 1)
      one.resend = true
    }
    const key = `${version}|${versions.get(e.requestId) ?? 0}|${e.viewport?.columns ?? 0}|${e.viewport?.rows ?? 0}`
    const kept = drawn.get(e.requestId)
    if (kept?.key === key) return kept.tree as Awaited<ReturnType<typeof Viewer>>
    const shown = await shownOf($, props.output)
    if (!shown) return next(e)
    const view = atStep(shown, e.requestId)
    const tree = await Viewer($, e, view, e.requestId, false, e.viewport)
    drawn.set(e.requestId, { key, tree })
    // As the play button does: send the frame on screen to the terminal again.
    if (one.resend) {
      one.resend = false
      void $.clock.sleep(120).then(() => draw($, e.requestId, sideOf(view, e.requestId), view)).catch(() => undefined)
    }

    return tree
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const shown = await read($, current)
    if (!shown) return <Text dimColor>Nothing to show yet. Run /img path/to/file</Text>

    return Viewer($, e, atStep(shown, PANE), PANE, true, paneSize(e.viewport, e.props as PaneProps))
  })

  on('command.run', { command: 'show-your-work' }, async ($, e) => {
    await setUp($)
    if (/^tour$/i.test(e.args.trim())) {
      startTour($)
      return { text: TOUR_TEXT }
    }
    // Run again while they're open, the settings close.
    if ((await $.ui.panes()).some(pane => pane.id === WELCOME)) {
      await $.ui.close({ id: WELCOME })
      return { text: 'Closed the show-your-work settings.' }
    }
    await openSettings($)
    return { text: 'Opened the show-your-work settings.' }
  })

  on('ui.render', { component: 'Pane', requestId: WELCOME }, async ($, e) => {
    await read($, welcome)
    await loadSettings($)
    return Settings($.ui.resolve(e) as Ui, $)
  })


  // The welcome's row: /show-your-work as the plugin ran it on install.
  const welcomeRows = new Set<string>()
  const tourRows = new Set<string>()
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const row = e.props as { command?: string; args?: string; text?: string; isErrored?: boolean; onScreen?: unknown }
    // /img: the player, in the chat under the command.
    if (row.command === 'img' && !row.isErrored && (row.text ?? '').includes(MARK)) {
      const shown = await shownOf($, row.text ?? '')
      if (!shown) {
        // A row from before a restart: the picture is no longer at hand.
        const { Text } = $.ui.resolve(e) as Ui
        return <Text dimColor>{(row.text ?? '').split('\n')[0]}</Text>
      }
      const one = player(e.requestId)
      if (row.onScreen === null && one.timer) stop($, e.requestId)
      return Viewer($, e, atStep(shown, e.requestId), e.requestId, false, e.viewport)
    }
    if (row.command !== PLUGIN) return next(e)
    if (/^tour$/i.test(row.args?.trim() ?? '') || (row.text ?? '').includes(TOUR_TEXT)) {
      // A tour row not drawn before is the newest: it becomes the live one.
      if (!tourRows.has(e.requestId)) {
        tourRows.add(e.requestId)
        const was = tourSite
        tourSite = e.requestId
        const isFresh = isTourPending || !was
        isTourPending = false
        // Drawing can't change state: the stop (re)starts just after.
        void $.clock.sleep(0).then(() => { if (was && was !== tourSite) stop($, was); goToStop($, isFresh ? 0 : tourStop) }, () => undefined)
      }
      if (e.requestId !== tourSite) {
        const { Text } = $.ui.resolve(e) as Ui
        return <Text dimColor>This tour moved to a newer one below.</Text>
      }
      await read($, welcome)
      return Tour($, e, e.viewport)
    }
    if (!welcomeRows.has(e.requestId)) {
      if (!(row.text ?? '').includes(WELCOME_TEXT)) return next(e)
      welcomeRows.add(e.requestId)
    }
    return Opening($, e, e.requestId, e.viewport)
  })
}
