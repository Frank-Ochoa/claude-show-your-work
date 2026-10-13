<p align="center">
  <img src="docs/homepage.jpg" alt="A recording of the Tern homepage plays inside Claude Code, with the list of what changed beside it" width="100%">
</p>

<h1 align="center">claude-show-your-work</h1>

<p align="center">Claude Code can show you pictures and play videos in the terminal.</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white" alt="Claude Code plugin"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Ghostty-supported-3B82F6?logo=gnometerminal&logoColor=white" alt="Works in Ghostty"></a>
  <a href="#install"><img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" alt="macOS"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/iamumeransari/claude-show-your-work?color=22C55E" alt="MIT license"></a>
</p>

A Claude Code plugin that lets you see Claude's work without leaving the terminal: web pages, designs, charts, videos and recordings of your app being tested.

## Install

Run these two commands in Claude Code:

```
/plugin marketplace add https://github.com/iamumeransari/claude-show-your-work.git#releases
/plugin install show-your-work@iamumeransari
```

You need macOS, the Ghostty terminal and Claude Code 2.1.287 or later. Videos also need ffmpeg: run `brew install ffmpeg`, or ask Claude to install it.

When the install finishes, a short tour shows you around. Run `/show-your-work` at any time to change your settings.

## Usage

Claude shows you its work in the chat whenever it builds or changes something visual. You can also ask for it directly:

- "Give me four directions for the homepage hero and show them side by side."
- "Build the sign-up form, test it, and show me the recording."
- "Fix the billing toggle and show me before and after."

### Design

<p align="center">
  <img src="docs/concepts.jpg" alt="Four landing page concepts for Tern shown in the chat" width="49%">
  <img src="docs/breakpoints.jpg" alt="The Tern homepage at desktop, tablet and phone sizes shown in the chat" width="49%">
</p>

Compare design concepts side by side, or check one page at desktop, tablet and phone widths in a single image.

### Feature testing (QA)

<p align="center"><img src="docs/qa-product.jpg" alt="A recording of a new-trip form being tested, with what changed and the checks beside it" width="100%"></p>

Claude tests the features it builds with Playwright, records each run and plays it in the chat. The changes are listed beside the video, and clicking one jumps to that moment. Each check turns green or red when the video reaches it.

For a bug fix, Compare plays the old and new versions side by side, in sync.

### Video

<p align="center">
  <img src="docs/persona.jpg" alt="A character sheet for an ad persona shown in the chat" width="49%">
  <img src="docs/reel.jpg" alt="A vertical video ad made from that persona plays, with the ad's structure listed next to it" width="49%">
</p>

Videos play with their sections listed beside them. Earlier versions stay in History, so you can go back and compare drafts.

## How it works

Claude tells the plugin which file to show, and the plugin draws it in Ghostty. Pictures go to your screen and never to Claude, so showing them costs no tokens. Videos are decoded with ffmpeg a few seconds at a time, so even long ones use little memory.

If something can't be shown, a note in the chat explains why and gives you a button to copy the fix.

## Terminals

The plugin works in Ghostty. Inside tmux, add `set -g allow-passthrough on` to `~/.tmux.conf` so pictures can reach the terminal.

## FAQ

### Does it update itself?

Yes, and only from this repository. To change how it updates, run `/show-your-work`.

### How do I see the tour again?

Run `/show-your-work tour`. It covers recordings, before and after, version history and the settings.

### Does it take up much space?

No. It keeps recent pictures and videos so you can flip back through them, and clears out the oldest once they add up to about 1 GB.

### Does it collect any data?

Only anonymous counts, such as which version is in use. No sensitive data is ever shared. You can turn it off with `/show-your-work`.

## Feedback

To report a bug or suggest a change, [open an issue](https://github.com/iamumeransari/claude-show-your-work/issues).

## For developers

<details>
<summary>Tools, settings and local development</summary>

The plugin gives Claude two tools, `show_image` and `show_video`. A basic call needs only a path. For a before and after, Claude also passes the old file and the test results:

```jsonc
{
  "path": "qa/after.webm",          // the run on the fixed version
  "compare": "qa/before.webm",      // the same steps on the old version
  "title": "Pricing page",
  "url": "http://localhost:3000/pricing",
  "changes": [                      // what changed, and the second it shows up
    { "title": "Annual toggle sets prices", "at": 3.2 },
    { "title": "Plan buttons line up", "at": 5.4 }
  ],
  "summary": [                      // the test results, at most three lines
    { "label": "Billing: toggle works", "ok": true, "passed": 1, "total": 1 },
    { "label": "Layout: plans, buttons", "ok": true, "passed": 3, "total": 3 }
  ]
}
```

Videos are cut into frames at up to 12 per second, at the width the window shows them (at most 2400 px), with a cap of 900 frames. To open a file yourself, run `/img path/to/file.png`.

To turn off updates and usage counts without opening the settings, add this to `~/.claude/settings.json`:

```json
"env": { "SHOW_YOUR_WORK_AUTO_UPDATE": "0", "SHOW_YOUR_WORK_TELEMETRY": "0" }
```

To work on the plugin, edit `hooks/register.tsx` and run `/reload-plugins` to load your changes. Before sending a change, run `claude plugin validate .` and `claude plugin test .`.

</details>

## License

[MIT](LICENSE). Photography in the examples is from [Unsplash](https://unsplash.com), used under the Unsplash License.

<p align="center"><a href="#install"><img src="docs/end-card.jpg" alt="show-your-work, with the install commands" width="100%"></a></p>
