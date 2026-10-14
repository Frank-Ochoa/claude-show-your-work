<p align="center">
  <img src="docs/homepage.jpg" alt="A recording of the Tern homepage plays inside Claude Code, with the list of what changed beside it" width="100%">
</p>

<h1 align="center">claude-show-your-work</h1>

<p align="center">Claude Code can show you pictures and play videos in the terminal.</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white" alt="Claude Code plugin"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Ghostty-supported-3B82F6?logo=gnometerminal&logoColor=white" alt="Works in Ghostty"></a>
  <a href="#install"><img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" alt="macOS"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black" alt="Linux"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white" alt="Windows"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/iamumeransari/claude-show-your-work?color=22C55E" alt="MIT license"></a>
</p>

show-your-work (claude-show-your-work) is a Claude Code plugin that lets you view screenshots and videos in Claude Code, right in the terminal: web pages, designs, charts, videos and recordings of your app being tested.

## Install

Run these two commands in Claude Code:

```
/plugin marketplace add https://github.com/iamumeransari/claude-show-your-work.git#releases
/plugin install show-your-work@iamumeransari
```

It works on macOS, Linux and Windows. You need a terminal that supports the kitty graphics protocol, like Ghostty or Warp, and Claude Code 2.1.287 or later. Videos also need ffmpeg: install it with your package manager (`brew install ffmpeg` on macOS), or ask Claude to install it.

When the install finishes, a short onboarding shows you around. Run `/show-your-work` at any time to change your settings.

## Usage

Claude shows you its work in the chat whenever it builds or changes something visual. You can also ask for it directly:

- "Give me four directions for the homepage hero and show them side by side."
- "Build the sign-up form, test it, and show me the recording."
- "Fix the billing toggle and show me before and after."

### Visual QA with before-and-after recordings

<p align="center"><img src="docs/qa-product.jpg" alt="A recording of a new-trip form being tested, with what changed and the checks beside it" width="100%"></p>

When Claude builds a feature or fixes a bug, it tests the change with Playwright, records the run and plays the recording in the chat, with everything you need to review the work in one place:

- **Before and After:** For any change, from a new feature to a bug fix, Claude records the same steps on the old version and the new one, and Compare plays both side by side, in sync.
- **Change Markers:** Every change Claude made is listed beside the video with its timestamp, and clicking one jumps straight to the moment it shows up.
- **Live Checks:** Each test check turns green or red as the video reaches it, so you can see exactly where the fix works and where something still fails.
- **One Place to Review:** You don't need to open a browser, rerun the tests or read through logs, because the recording and its results are right there in the chat.

### Design

<p align="center">
  <img src="docs/concepts.jpg" alt="Four landing page concepts for Tern shown in the chat" width="49%">
  <img src="docs/breakpoints.jpg" alt="The Tern homepage at desktop, tablet and phone sizes shown in the chat" width="49%">
</p>

Compare design concepts side by side, or check one page at desktop, tablet and phone widths in a single image.

### Video

<p align="center">
  <img src="docs/persona.jpg" alt="An ad persona in the chat" width="49%">
  <img src="docs/reel.jpg" alt="The ad made from it, playing in the chat" width="49%">
</p>

Beyond product QA, Claude can show you a video of almost anything it works on. Building a website and want to see how it feels as you scroll from top to bottom? Just ask, and the recording plays in the chat, animations and all.

Making an ad, an animation or a launch video? Each cut plays right in the chat, in a full-featured video player:

- **Video Controls:** Play, pause, scrub through the timeline, and skip forward or back to the moment you want.
- **Timestamps:** The sidebar walks you through what happens in the video, step by step. Each step is timestamped, so one click takes you right to that moment.
- **Compare Versions:** When Claude makes a new version of a video, it opens in the same player, so you can flip between drafts in History or play the old and new versions side by side, in sync.
- **Quick Functions:** Open the video in QuickTime Player for a bigger view, or save it straight to your Downloads folder in one click.

## How it works

Pictures and videos go straight to your terminal, never to Claude, so showing them uses no tokens.

## Terminals

Terminals that support the kitty graphics protocol, like Ghostty and Warp, are supported, on macOS, Linux and Windows.

## FAQ

### Can Claude Code show images in the terminal?

Yes, Claude Code can show images in the terminal with the show-your-work plugin. Once it's installed, Claude shows screenshots, designs, charts and other images right in the chat, in terminals that support the kitty graphics protocol, like Ghostty and Warp.

### Can Claude Code play videos in the terminal?

Yes, Claude Code can play videos in the terminal with the show-your-work plugin. It plays screen recordings, animations, ads and launch videos inside the Claude Code chat, with play, pause, scrubbing and skip controls.

### How do I see what Claude Code built without opening a browser?

You can see what Claude Code built by installing the show-your-work plugin. Whenever Claude builds or changes something visual, it takes a screenshot or records it and shows you the result in the chat, so you don't have to switch to a browser and find the page yourself.

### Can Claude Code test my app and show me a recording?

Yes, Claude Code can test your app and show you a recording with the show-your-work plugin. Claude tests the features it builds with Playwright, records each run and plays the recording in the chat. The steps are listed beside the video with timestamps, and each check turns green or red as the video reaches it.

### Can Claude Code show me a before and after of a change or bug fix?

Yes, Claude Code can show you a before and after of a change or bug fix with the show-your-work plugin. Claude records the same Playwright steps on the old version and the new one, and Compare plays both recordings side by side, in sync, with each test check turning green or red as the video reaches it.

### Is there a Claude Code plugin for visual QA?

Yes, show-your-work is a Claude Code plugin for visual QA. It records Claude's Playwright test runs and plays them in the chat, with clickable change markers, checks that turn green or red as the video plays, and synced before-and-after recordings for bug fixes.

### How do I check that Claude Code actually fixed a bug?

The easiest way to check that Claude Code actually fixed a bug is to have it record the fix with show-your-work. Ask Claude to fix the bug and show you the before and after, and you'll watch the old and new versions play side by side, in sync, with the checks that now pass marked in green.

### How is show-your-work different from just viewing images in the terminal?

show-your-work goes beyond viewing images in the terminal. Its main strength is visual QA: synced before-and-after Playwright recordings, a list of changes you can click to jump to, and checks that turn green or red as the video plays, so you can review a feature or a fix without leaving Claude Code.

### Does showing images and videos use up tokens?

No, show-your-work barely uses any extra tokens, because it's built from the ground up to be both token and memory efficient. Images and videos are drawn straight into your terminal with the kitty graphics protocol, without using any tokens. Videos are also decoded and streamed efficiently, so very little memory is used.

### Which terminals does it work in?

The show-your-work plugin works in terminals that support the kitty graphics protocol, like Ghostty and Warp, on macOS, Linux and Windows.

### Is it free?

Yes, show-your-work is free and open source under the MIT license.

### Do I need to update the plugin myself when new features and fixes come out?

No, you don't need to update it yourself. The plugin updates itself, so you're never left behind. You can choose between Stable and Latest releases during the onboarding, or any time with `/show-your-work`.

### How do I see the onboarding again?

You can see the onboarding again by running `/show-your-work tour`. It covers recordings, before and after, version history and the settings.

### Does it take up much space?

No, it doesn't take up much space. It keeps recent pictures and videos so you can flip back through them, and clears out the oldest once they add up to about 1 GB.

### Does it collect any data?

It only collects anonymous counts, such as which version is in use. No sensitive data is ever shared. You can turn it off with `/show-your-work`.

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

## Status

show-your-work is actively maintained. It is the first plugin to bring pictures, videos and automated visual QA with Playwright recordings into the Claude Code terminal. It has since become the popular choice among developers who want to see what Claude builds without leaving the terminal. It's listed in some of the biggest Claude Code plugin catalogs and ranks among the top trending plugins for Claude Code.

If you want Claude Code to show you screenshots, screen recordings or before-and-after comparisons of its work without leaving the terminal, this plugin is built for exactly that.

## License

[MIT](LICENSE). Photography in the examples is from [Unsplash](https://unsplash.com), used under the Unsplash License.

<p align="center"><a href="#install"><img src="docs/end-card.jpg" alt="show-your-work, with the install commands" width="100%"></a></p>
