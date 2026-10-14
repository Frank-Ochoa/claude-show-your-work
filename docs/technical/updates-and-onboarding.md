# Updates, settings and onboarding

## Channels and the updater

- Two channels, two branches: **Stable** follows `releases`, **Latest** follows `latest` (`BRANCHES`). Stable is the default. `main` is development only. Versions before 0.6.0 checked `main`.
- Once a day (`updateCheckedAt`), the updater fetches `.claude-plugin/plugin.json` from the channel's branch. If the version is newer it runs `claude plugin marketplace update` and `claude plugin update`; the new version loads in the next session. Failures say nothing to the user.
- An install pinned to a tag stays on it. A branch that doesn't exist on GitHub yet: stay where it is.
- **Switching channel** moves the marketplace to `url#branch` and reinstalls (`MOVE_SH`). It runs detached (`DETACH`), so quitting Claude Code halfway can't leave the plugin uninstalled. If the new branch fails, the old source goes back, retried twice.
- Off with `SHOW_YOUR_WORK_AUTO_UPDATE=0` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Update choices saved by earlier versions (`consent` in 0.5.12, `updatesOff` in 0.5.16) are no longer read; their usage data choice (`statsOff`, `consent.stats`) carries over (`earlierNo`).

## Settings

- `/show-your-work` opens the settings pane: update channel and usage data.
- Saved in the plugin store under `settings`.
- `/show-your-work tour` starts the tour. There is no other settings command (0.5.16's `/show-your-work-settings` was dropped in 0.6.0).

## Welcome and tour

- **Every install sees the welcome and tour once**, updates included, since installs from before 0.6.2 never had one. Shown means `toured` is stored. 0.6.0–0.6.1 stored `welcomed` both when they showed the welcome (fresh install) and when they skipped it (update). An install with `welcomed` but no `toured` is shown it only if a version folder from before 0.6.0 is still in the plugin cache next to this one (`hadVersionBefore06`); otherwise it already saw it and `toured` is stored quietly. Claude Code deletes orphaned version folders after some days, so an update whose old folders are gone is taken for a 0.6 install and misses the tour rather than seeing it twice. Only a fresh install holds updates and usage counts until the welcome; an update (`welcomed`, `installId` or `updateCheckedAt` stored) starts them straight away.
- The tour has five stops (`STOPS`), each pointing at one real control; a stop is done when the person uses it. The last stop shows the settings.
- Tour media in `assets/` is 16:10, 1600x1000 (the trip-form recording 2400x1500). Change timings in `prepareTour` if a recording changes.
