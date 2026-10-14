# Video

Kitty-protocol terminals show still pictures only, so a video plays as PNG frames swapped with `$.ui.blit`.

## Frames

- Sampled at up to 12 frames a second (`sampleRate`). A clip of known length has at most `MAX_STREAMED` (3600) frames, so up to five minutes plays at the full rate; only a few chunks are on disk at once, so a longer clip costs no more disk or memory. A clip with no duration is cut whole and stays at `MAX_FRAMES` (900). (A 24 fps option was tried and dropped: smoother, but it doubled the cutting work.)
- Cut at the width the player really shows (`frameWidth`), so the picture fills its box (the terminal never enlarges it).
- A clip of known length is cut as it plays, `CHUNK` (24 frames, 2 s) at a time. Around the chunk on screen, 5 s behind and 5 s ahead stay on disk (`chunksBehind`, `chunksAhead`: 3 chunks each); the rest are pruned. The ones ahead are cut in advance, two ffmpeg processes at a time (`cutAhead`, `CUT_WORKERS`: a second process got ~20–25% more done on an M1, more added little). Chunks two or more ahead are cut at a lower priority (`gently`): macOS's utility class (`taskpolicy -c utility`), which on an M1 cut as fast as normal with the machine free and gave way (3× slower) with every core busy. `nice -n 10` didn't give way at all on macOS, and the background class (`taskpolicy -b`) was 3.5× slower even when free, so playback stalled. Linux uses `nice`. The chunk needed next always runs at normal priority. Background cuts also run on one thread (`ONE_THREAD`): for 1 s of video at 2400 px that's 0.85 s of CPU and 213 MB instead of 1.3 s and 368 MB, still faster than playback. Before a video is shown, its first 5 s are cut too (`prefill`), waiting at most 4 s. Keeping only one chunk behind and one ahead made every skip cut its chunk first, a visible freeze. Frame 1 (the poster) always stays. A longer seek or a scroll back cuts the chunk again.
- A clip with no duration (some MediaRecorder webm) is cut whole.
- A white lead-in at the start of a recording is skipped (`whiteLead`).
- Each clip gets a folder `v-<key>` where the key covers the file, its size and time, and the cut width, so a wider window cuts the clip again, wider.
- The size label shows the clip's own size (from ffprobe), not the frames' size.

## 256 colours

Frames are a preview copy, so they are cut with a 256-colour palette (`PALETTE`): one palette per chunk, no dithering. Measured on the tour videos at 1600 px:

| | per frame | per 2 s chunk |
|---|---|---|
| full colour, `-compression_level 1` | 346 to 385 KB | 0.2 to 0.33 s |
| 256 colours, one palette per chunk | 140 to 163 KB | 0.46 to 0.48 s |

- No visible difference on photos, text or soft shadows. A very smooth gradient could band; the original is untouched and View opens it.
- A palette per frame (`stats_mode=single`) is no smaller and ~3x slower. Dithering (`sierra2_4a`, `bayer`) costs time and makes PNGs bigger.
- Lossless tuning (`-pred mixed`, higher compression levels) gains almost nothing for much more time.
- **`palettegen` waits for the end of its input.** Every ffmpeg call that cuts frames must limit the input with `-t` (`chunkSeconds`), not only the output with `-frames:v`. Without `-t` the palette step reads the whole video, and each 2 s chunk took ~3 s.

## Playback

- A video Claude shows plays once by itself (`freshCalls`), not ones a reload redraws.
- Scrolling a player out of view stops it; scrolling back sends the frame on screen again.
- Clicking a change pauses the video at that moment.
- Compare plays the original and updated recordings side by side, in sync: times are mapped through the checks both sides share (`anchors`, `mapTime`).
- Over ssh every frame crosses as bytes; expect it to be slower than local.
- **One swap at a time per picture** (`blit`, `swaps`). A swap still in flight holds only the newest frame asked for; frames in between are dropped. Each draw takes a ticket, and a draw whose frame was ready after a newer draw's is skipped. Before this, every tick fired its own swap: on a busy machine they queued (playback fell further behind) and landed out of order (frames jumped back and forth).
- The draw check (`probe`, once per session, 250 ms after the first draw) re-sends the frame on screen, not the poster: sending the poster jumped a playing clip back to its start for a moment.
- The play timer never runs ahead of the frames: a tick whose next frame is still being cut waits for it.

## Timing log

`SHOW_YOUR_WORK_DEBUG=1` writes playback timings to `debug.log` in the temp folder, flushed once a second: `play` (fps, frame count), `tick gap=` (ms since the last tick; 83 at 12 fps), `wait` (next frame not cut yet), `cut chunk= ms=`, `blit frame= ms=`, `drop` (a frame skipped while a swap was in flight), `stale` and `redraw`. Measured on an M1: a 2 s chunk cuts in 0.2–0.4 s and a frame reads in ~1 ms, so lag is the timer firing late or the swaps, not decoding.
