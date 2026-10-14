# Architecture

How a picture or video gets from Claude's tool call to the terminal, and which module does each part. The topic notes go deeper on each step.

## Modules

| Module | Holds |
|---|---|
| `register.tsx` | The entry module: the `show_image` and `show_video` tools, the `/img` and `/show-your-work` commands, and every `on(...)` hook that ties the modules together |
| `state.ts` | What more than one module reads or changes: the session's facts, playback and tour progress, the settings |
| `setup.ts` | Found once per session: temp folder, home, ffmpeg and ffprobe, ssh, the terminal |
| `history.ts` | Every shown file kept in `.show-your-work/`, linked to the version before, and the marker a tool result carries |
| `media.ts` | Getting files ready to draw: PNG conversion, video frames cut a chunk at a time, the side-by-side clip of two runs |
| `layout.ts` | Sizing: from the room a player has to its box in cells and the pixels its picture needs |
| `player.tsx` | Playback (timer, frame swaps, seek, compare) and the components that draw the player |
| `onboarding.tsx`, `tour.ts` | The settings pane, the welcome and the tour |
| `updater.ts` | The daily update check and moves between Stable and Latest |
| `telemetry.ts` | Anonymous usage counts and the local timing log |

Only `register.tsx` is listed in `hooks.json`; it imports the rest. The loader's rules apply in every module (see `plugin-loader-and-hooks.md`).

## A tool call, end to end

1. **Claude calls `show_image` or `show_video`** with a path, and optionally a title, changes, checks, a `compare` file and a `previous` version.
2. **`tool.call` hook** (`register.tsx`): finds the file (`locate`), refuses anything that isn't a picture or video, and copies it into the version history (`storeVersion`, `history.ts`), linked to the version before it.
3. **Preparing** (`prepare`, `media.ts`): a picture becomes a PNG at the width the player needs. A video gets a poster frame and its first 2 s chunk of frames; the rest are cut as it plays. A compare file is prepared the same way, and two videos get their matching moments lined up (`anchors`).
4. **The result** goes back to Claude as a line of text plus a marker holding the prepared item. Claude never receives the picture, so showing it costs no tokens.
5. **`ui.render` for the `ToolResult`** (`register.tsx`): reads the marker (`shownOf`) and draws the `Viewer` (`player.tsx`). An unchanged player hands back its last drawing, and a picture scrolled back into view is only re-sent if the terminal may have dropped it.
6. **Sizing** (`layout.ts`): the terminal's cell size in pixels comes from the tty. The player picks a box in cells for the picture's shape, and a sharper copy is made in the background if the box needs more pixels.
7. **Drawing**: the `Image` element points the terminal at the PNG by path, and the terminal draws it through the kitty graphics protocol (Ghostty, kitty, WezTerm, Warp, Konsole). Over ssh the bytes are sent instead.
8. **Playback** (`player.tsx`): a timer advances one frame at a time at up to 12 fps. Each frame is swapped in with `$.ui.blit`, one swap in flight per picture with the newest frame winning. Chunks 5 s ahead are cut in advance and 5 s behind are kept; the rest are pruned.

## Where to look

- A picture is the wrong size or blurry: `layout.ts`, then `showing-images.md`.
- A video stutters or stalls: `player.tsx` (`play`, `blit`), `media.ts` (`ensureChunk`), then `playing-video.md` and its timing log.
- A version is missing from History: `history.ts`, then `cache-and-version-history.md`.
- The plugin doesn't load at all: `plugin-loader-and-hooks.md`, and run `claude plugin test .`.
