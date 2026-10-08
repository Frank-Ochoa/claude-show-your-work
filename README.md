# claude-show-your-work

> **Stop opening localhost to check what Claude did.**
> Claude shows you its finished work right in the chat: screenshots, videos of it clicking through your app, and synced before/after QA. No tab-switching, no "let me go check".

A Claude Code plugin for terminals that can draw pictures (Ghostty, kitty).

## What you get

- **Pictures in the chat.** Whenever Claude makes something visual (a page, a slide, a chart, a mockup), it shows it inline, unasked.
- **Videos in the chat.** Playwright runs of Claude clicking through your app play right there, by themselves, with Play/Pause, a clickable progress bar and ±5 s seek.
- **Before/after QA.** Claude records the same flow on the original and the updated version. Switch between **Original / Updated / Both**: Both plays them side by side, lined up by matching their frames, so every step happens at the same moment on both sides.
- **What changed, and the QA in three lines.** A sidebar lists the key changes (click one to jump to its moment; the one playing is lit) and a QA card with a tick or cross and the checks passed. In a narrow window it moves under the player.
- **One row of controls.** ↗ Open page (the localhost or deployed URL, at the moment you're on) or ↗ View, Save to Downloads, Copy path.
- **Every window stays.** Scroll up and every picture and video Claude showed is still there.
- **/img <path>** opens any image or video in a side pane.

## Install

```
/plugin marketplace add iamumeransari/claude-show-your-work
/plugin install show-your-work@show-your-work
```

Needs a terminal with the kitty graphics protocol (Ghostty, kitty), `ffmpeg` for video, and macOS (`sips` converts non-PNG images).

## How Claude uses it

Two tools, `show_image` and `show_video`. For QA, pass `compare` (the before file), `changes` (each `{ title, at }`), `summary` (up to three `{ label, ok, passed, total }`), and optionally `checks`, `pr` and `url`.

Videos are cut into frames with ffmpeg (up to 900 frames at up to 12 fps, 960 px wide), so keep clips short.

## Develop

Edit `hooks/register.tsx`, then `/reload-plugins`. Check with `claude plugin validate .` and `claude plugin test .`.
