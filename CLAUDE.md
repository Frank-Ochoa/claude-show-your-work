# show-your-work

A Claude Code plugin that draws pictures and videos in the chat (Ghostty). The code is in `hooks/`, one module per area; tests are in `tests/`.

- `register.tsx`: the entry module (the only one in `hooks.json`): tools, commands and the hooks
- `state.ts`: what more than one module reads or changes
- `setup.ts`: temp folder, ffmpeg and the terminal, found at session start
- `layout.ts`: sizing, and fitting text to a width
- `media.ts`: preparing pictures and videos, frames, the side-by-side clip, the frame cache
- `history.ts`: version history and the shown item behind a result's marker
- `player.tsx`: playback and the player's components
- `onboarding.tsx` and `tour.ts`: settings, welcome and tour
- `telemetry.ts` and `updater.ts`: usage stats and updates

Before changing an area, read its notes in `docs/technical/`:

- `architecture.md`: the modules, and a tool call traced from Claude to the terminal
- `plugin-loader-and-hooks.md`: what the hooks loader rejects, and engine behaviour that isn't obvious
- `showing-images.md`: how pictures reach the screen, sizing, Ghostty's limits, ssh and background sessions
- `playing-video.md`: how videos become frames, chunks, the 256-colour palette
- `cache-and-version-history.md`: temp folder, version history, size caps, cleanup
- `updates-and-onboarding.md`: update channels, settings, welcome and tour
- `testing-and-debugging.md`: the test harness and its quirks, and how to check things on screen

A change is done when `npx -p typescript tsc -p .`, the Biome lint (see `testing-and-debugging.md`), `claude plugin validate .` and `claude plugin test .` pass, and anything visual has been looked at on screen in a normal (not background) Ghostty session. The tests can't see whether a picture draws.

When you learn something new about the engine, Ghostty or the test harness, add it to the right file in `docs/technical/`.
