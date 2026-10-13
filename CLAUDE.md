# show-your-work

A Claude Code plugin that draws pictures and videos in the chat (Ghostty). All the code is in `hooks/register.tsx`; tests are in `tests/`.

Before changing an area, read its notes in `docs/technical/`:

- `plugin-loader-and-hooks.md`: what the hooks loader rejects, and engine behaviour that isn't obvious
- `showing-images.md`: how pictures reach the screen, sizing, Ghostty's limits, ssh and background sessions
- `playing-video.md`: how videos become frames, chunks, the 256-colour palette
- `cache-and-version-history.md`: temp folder, version history, size caps, cleanup
- `updates-and-onboarding.md`: update channels, settings, welcome and tour
- `testing-and-debugging.md`: the test harness and its quirks, and how to check things on screen

A change is done when `npx -p typescript tsc -p .`, `claude plugin validate .` and `claude plugin test .` pass, and anything visual has been looked at on screen in a normal (not background) Ghostty session. The tests can't see whether a picture draws.

When you learn something new about the engine, Ghostty or the test harness, add it to the right file in `docs/technical/`.
