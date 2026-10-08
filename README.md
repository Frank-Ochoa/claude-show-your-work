# image-view

A Claude Code mod that shows images and plays videos inline in the terminal (Ghostty, kitty).

- **show_image / show_video tools**: Claude shows the work it made (rendered pages, screenshots, Playwright recordings) right in the conversation, unasked.
- **Player window**: autoplay, a labelled Play/Pause/Resume/Replay control, a clickable progress bar, ±5 s seek, Open / Reveal / Copy path / Full view.
- **QA mode**: pass `change`, `pr`, `checks` and `compare` (the before recording of the same flow). Videos open side by side, locked to the same moment, with a live line saying what changed right now and a clickable list of every fix and break. Images get a report beside them and Before/After tabs.
- **Comments**: ✎ Comment, pick the spot on a map of the picture, type the note: a numbered pin is drawn on the frame and marked on the timeline. Send all notes to Claude in one click.
- **Open page**: pass `url` (and a `url` per check) and ↗ Open page opens localhost or the deployed page at the moment you're on.
- **Quiet transcript**: each call shows as one line (`▶ Video · Agent QA · vs Live · 11 checks`), not its whole input.
- **/img <path>**: open any image or video in a side pane.

Videos are cut into frames with ffmpeg (up to 900 frames at up to 12 fps, 960 px wide). Non-PNG images are converted with macOS `sips`.

## Install

```
/plugin install image-view --marketplace iamumeransari/claude-image-view
```

Needs a terminal with the kitty graphics protocol (Ghostty, kitty), and `ffmpeg` for video.

## Develop

Edit `hooks/register.tsx`, then `/reload-plugins`. Check with `claude plugin validate .` and `claude plugin test .`.
