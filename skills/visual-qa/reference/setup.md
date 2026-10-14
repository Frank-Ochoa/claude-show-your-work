# Setup: starting the app and getting Playwright

## A temp folder for the run

Recordings, QA scripts and any tools you install go in one temp folder outside the project. Use Claude's scratchpad directory when the session has one, otherwise the OS temp folder:

```sh
QA_DIR="$(node -p "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'qa-'))")"
```

## Starting the app

Use the project's own script. Look in `package.json` `scripts` and in the project's notes (CLAUDE.md, AGENTS.md, README) for the start command, port and test login.

| Package manager (lockfile) | Install | Dev server |
|---|---|---|
| npm (`package-lock.json`) | `npm ci` | `npm run dev` |
| pnpm (`pnpm-lock.yaml`) | `pnpm install --frozen-lockfile` | `pnpm dev` |
| yarn (`yarn.lock`) | `yarn install --frozen-lockfile` (v1) or `yarn install --immutable` (v2+) | `yarn dev` |
| bun (`bun.lock`, `bun.lockb`) | `bun install --frozen-lockfile` | `bun run dev` |

Start it in the background, keep its process id, and wait until the port answers instead of sleeping:

```sh
node -e "const u=process.argv[1];(async()=>{for(let i=0;i<120;i++){try{await fetch(u);process.exit(0)}catch{}await new Promise(r=>setTimeout(r,500))}console.error('not up: '+u);process.exit(1)})()" http://localhost:5173
```

A production preview (`build` then `preview`/`start`) is closer to what ships and avoids dev-only overlays; use it when the change could behave differently in a build.

## Playwright

The helper imports `@playwright/test` or `playwright` from the folder you run the QA script in (or `projectDir`). Run the script from the project root when the project already has one of them.

When it doesn't, leave the project's dependencies alone and install into the temp folder:

```sh
npm i --prefix "$QA_DIR" playwright @axe-core/playwright      # or: pnpm add --dir, yarn --cwd, bun add --cwd
cd "$QA_DIR" && npx playwright install chromium --only-shell   # headless shell only; skip if the matching build is cached
```

Then pass `projectDir: process.env.QA_DIR` to `startRun`. Browsers are cached per Playwright version (`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`, `%USERPROFILE%\AppData\Local\ms-playwright`); if a matching `chromium_headless_shell-<rev>` is already there, install the Playwright version that uses that revision instead of downloading another browser (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

## Logging in

Log in inside the run with the project's test account, or log in once and save the session:

```js
await page.context().storageState({ path: `${process.env.QA_DIR}/auth.json` })
// later: startRun({ contextOptions: { storageState: `${process.env.QA_DIR}/auth.json` } })
```

Never use the person's real account or browser profile.

## Before/after worktree

```sh
BASE=$(git merge-base HEAD origin/main)          # or the commit before the fix
git worktree add "$QA_DIR/base" "$BASE"
# install there with the same package manager, start on another port (e.g. PORT=3001 or --port 3001)
# ... run the same QA script with QA_URL / QA_OUT pointing at the base ...
git worktree remove --force "$QA_DIR/base"
```

Env files (`.env.local`) are not in git; copy them into the worktree if the app needs them.
