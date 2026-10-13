# Video

Ghostty shows still pictures only, so a video plays as PNG frames swapped with `$.ui.blit`.

## Frames

- Sampled at up to 12 frames a second, at most `MAX_FRAMES` (900) per clip (`sampleRate`).
- Cut at the width the player really shows (`frameWidth`), so the picture fills its box (Ghostty never enlarges).
- A clip of known length is cut as it plays, `CHUNK` (24 frames, 2 s) at a time. The chunk on screen, the one before and the two after stay on disk; the rest are pruned. Frame 1 (the poster) always stays. A seek or a scroll back cuts the chunk again.
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
