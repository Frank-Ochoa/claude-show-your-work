export type Frames = { dir: string; count: number; fps: number; duration: number }

// One QA check: its name, whether it passed, and when it happens in a clip.
export type Check = { name: string; ok: boolean; at?: number }

// How a click on the picture itself is caught: a grid of blank buttons over
// the whole picture, one button in its centre, or none.
export type Overlay = 'grid' | 'center' | 'none'

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
  checks?: Check[]
  // the other side of a before/after, and the two sides' names
  compare?: Shown
  label?: string
  overlay?: Overlay
}

declare module 'claude-code' {
  interface PluginState {
    'image-view': { current: Shown | null }
  }
}
