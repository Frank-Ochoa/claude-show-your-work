# Updates, settings and onboarding

## Channels and the updater

- Two channels, two branches: **Stable** follows `releases`, **Latest** follows `latest` (`BRANCHES`). Stable is the default. `main` is development only. Versions before 0.6.0 checked `main`.
- Once a day (`updateCheckedAt`), the updater fetches `.claude-plugin/plugin.json` from the channel's branch. If the version is newer it runs `claude plugin marketplace update` and `claude plugin update`; the new version loads in the next session. Failures say nothing to the user.
- An install pinned to a tag stays on it. A branch that doesn't exist on GitHub yet: stay where it is.
- **Switching channel** moves the marketplace to `url#branch` and reinstalls (`MOVE_SH`). It runs detached (`DETACH`), so quitting Claude Code halfway can't leave the plugin uninstalled. If the new branch fails, the old source goes back, retried twice.
- Off with `SHOW_YOUR_WORK_AUTO_UPDATE=0` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Choices saved by earlier versions (`consent` in 0.5.12, `updatesOff` and `statsOff` in 0.5.16) carry over (`earlierNo`); choosing a channel in the settings replaces them.

## Settings

- `/show-your-work` opens the settings pane: show automatically, update channel, usage data.
- Saved in the plugin store under `settings`.
- `/show-your-work tour` starts the tour. There is no other settings command (0.5.16's `/show-your-work-settings` was dropped in 0.6.0).

## Welcome and tour

- **Only a fresh install sees the welcome.** Any key an earlier version stored (`EARLIER_KEYS`: `installId`, `updateCheckedAt`, `consent`, `statsOff`, `updatesOff`) means an update, and the welcome is skipped (`hasUsedBefore`). Once shown, `welcomed` is stored.
- The tour has five stops (`STOPS`), each pointing at one real control; a stop is done when the person uses it. The last stop shows the settings.
- Tour media in `assets/` is 16:10, 1600x1000 (the trip-form recording 2400x1500). Change timings in `prepareTour` if a recording changes.
