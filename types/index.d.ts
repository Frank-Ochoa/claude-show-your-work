export type Frames = { dir: string; count: number; fps: number; duration: number }

// One QA check: its name, whether it passed, and when it happens in a clip.
export type Check = { name: string; ok: boolean; at?: number; url?: string }

// A note the person pinned: where (0..1 across and down), when, and the
// frame with its numbered pin drawn on.
export type Note = { n: number; at: number; frame: number; x: number; y: number; text: string; file: string }

// A play button over the centre of a paused video, or none. (A grid of
// buttons over the whole picture was tried: it erases the picture.)
export type Overlay = 'center' | 'none'

export type Shown = {
  kind?: 'image' | 'video'
  // the PNG the terminal draws (a video's first frame)
  path: string
  // the file the user gave, for Open and Reveal
  source?: string
  width: number
  height: number
  title: string
  generation: number
  frames?: Frames
  // QA context: the change, its PR, the checks run
  change?: string
  pr?: string
  // the page the recording or picture is of, to open it there
  url?: string
  checks?: Check[]
  // the other side of a before/after, and the two sides' names
  compare?: Shown
  // Original and Updated merged into one clip, side by side, and its size
  pair?: Frames
  pairWidth?: number
  pairHeight?: number
  label?: string
  overlay?: Overlay
}

declare module 'claude-code' {
  interface PluginState {
    'image-view': { current: Shown | null }
  }
}
