# image-view

A Claude Code mod that shows images and plays videos inline in the terminal (Ghostty, kitty).

- **show_image / show_video tools**: Claude shows the work it made (rendered pages, screenshots, Playwright recordings) right in the conversation, unasked.
- **Player window**: autoplay, a labelled Play/Pause/Resume/Replay control, a clickable progress bar, ±5 s seek, Open / Reveal / Copy path / Full view.
- **QA mode**: pass `change`, `pr`, `checks` and `compare` (the before file) to get a report beside the picture, what was fixed or broke, and synced Before/After tabs.
- **/img <path>**: open any image or video in a side pane.

Videos are cut into frames with ffmpeg (up to 900 frames at up to 12 fps, 960 px wide). Non-PNG images are converted with macOS `sips`.

## Install

```
/plugin install image-view --marketplace iamumeransari/claude-image-view
```

Needs a terminal with the kitty graphics protocol (Ghostty, kitty), and `ffmpeg` for video.

## Develop

Edit `hooks/register.tsx`, then `/reload-plugins`. Check with `claude plugin validate .` and `claude plugin test .`.
