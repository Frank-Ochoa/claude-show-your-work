---
name: visual-qa
description: Use when the person asks you to test, verify or QA a feature, flow or change in a web app, or when you are fixing a bug they reported and need to prove it's fixed. Records a headless Playwright run of the main flow, checks the task's few success criteria against the video, and shows it with show_video as Deep QA (with a before/after for a fix). Not for ordinary requests: when the person just wants the work done, do the work.
---

# Visual QA

Prove a change works by running it in a real browser, recording the run, and showing the video with every check pinned to the moment it was verified. The person watches the flow, sees failures first with what should have happened and what did, and can jump to each one.

Everything runs headless. Never open a visible browser window or drive the person's own browser.

## Light tier: Verify

Most work doesn't need a recorded run. It needs an honest answer to three questions:

1. **What was the task?** In the person's words, not the implementation's.
2. **What does success look like?** The few things that must be true for them to be happy with it: what they will see, use or rely on. "It builds" is never a criterion on its own.
3. **Was each one met, and how do you know?** Check it in whatever way fits the work: open it, measure it, run it, compare it to the source. When a tool already verified something (a test suite, a renderer's own timing checks), report that result instead of repeating it.

Report each criterion as one check: a full sentence saying what was met and the evidence ("Every chart total matches the spreadsheet: Q3 revenue reads $1.24M in both"), and `expected` and `actual` for any that weren't. Leave out what you couldn't check, and pass no checks if nothing was checked. Leave `qa` unset: these show as **Verify**. `reference/extras.md` has measuring recipes for common cases.

## Full tier: a feature, flow or fix

Seven stages. The helper `scripts/qa-run.mjs` in this skill's folder (the base directory shown when the skill loads) does the recording, timing and result file.

### 1. Plan

Start from the task, not the code: what was asked, and what has to be true for the person to be happy with it. Those success criteria are what you check. Then read the code that changed and trace the real controls a person uses (the button's label, the field's label, the route it goes to), and write:

- **One main flow** that proves the criteria, as numbered steps. Each step names its control and its expected result: "3. Click **Continue**: the URL becomes /welcome and the page says *Signed up as maya@example.com*."
- **Only the edge cases the task is about:** the input the fix was for, the error path it added. Not a test suite.

Don't add checks for their own sake. Layout at other widths, accessibility scans, console errors and keyboard passes belong in the run only when the change is about them (`reference/extras.md` has recipes).

When the change is large or the flow is ambiguous, show the person the short plan before running it. Otherwise just run it.

Each plan step becomes a `run.step(...)` name, and each expected result becomes one check. Write every check `name` as one full sentence saying what was verified, with concrete values: `Typing "maya@" shows "Enter a valid email" under the field`, never `Email validation`.

### 2. Write the run

Start the app the way the project does (its dev script or a preview build; see `reference/setup.md` for npm, pnpm, yarn and bun), and wait until the port answers.

**Recon first.** Before writing assertions, load the page headless, wait for it to settle, and look: take a screenshot, read `page.getByRole(...)` names or dump the accessibility tree. Write locators from what is really there, not from guesses.

Then write the QA script in a temp folder (never in the project), following these rules:

- **Locators** by role, label and text: `getByRole('button', { name: 'Continue' })`, `getByLabel('Email')`. CSS selectors only when nothing accessible exists.
- **Retrying assertions**: `run.expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`. They wait until true or time out. Never a fixed sleep to wait for something.
- **One check per success criterion, and no follow-on checks.** Don't add checks that would only fail because an earlier one did: one bug should read as one failure. Every check runs on both sides of a before/after, so the two line up.
- **Console errors** are collected during the run and reported only if they are a problem of their own: when everything else passed. A broken page's errors are the same bug.
- **Fresh, isolated context** for every run: no shared cookies or storage. Log in inside the run, or load a saved `storageState`.
- **Stub third parties** that are slow, flaky or cost money (payments, analytics, maps, LLM calls) with `page.route`.
- **Freeze time and randomness** when they affect what is shown: `startRun({ clock: '2026-05-01T10:00:00Z' })`, and seed `Math.random` with `page.addInitScript`.

Patterns and snippets: `reference/playwright-patterns.md`. A complete worked script: `reference/example-qa.mjs`.

### 3. Record

`startRun` records with the settings that keep the video sharp and small: headless, viewport 1280x800 unless the change is about another size, deviceScaleFactor 1, video size equal to the viewport. On Playwright 1.59 and later it also turns on action annotations, so clicks are marked in the video. The video file is only complete after the context closes, which `run.finish()` does.

Keep clips short: one flow, under a minute. Type with a small `delay` so the viewer can follow, but don't pad with waits.

### 4. Time it

The helper measures every `at` from the moment the video starts:

- A passing check's `at` is when its assertion resolved. A failing check's `at` is when it began looking, the moment the thing should have been on screen, so jumping to it shows the failure rather than a frame seconds later.
- A change's `at` is when the changed UI first shows. Start `run.change(title, locator)` without `await` before the action that reveals it, and await it after the check, so it stamps the first frame the UI appears and adds no waiting of its own.

```js
const shown = run.change('Email is checked as you type', page.getByText('Enter a valid email'))
await page.getByLabel('Email').pressSequentially('maya@', { delay: 80 })
await run.check('Typing "maya@" shows "Enter a valid email" under the field',
  () => run.expect(page.getByRole('alert')).toHaveText('Enter a valid email'),
  { expected: '"Enter a valid email" under the Email field', actual: async () => `Message: "${await page.getByRole('alert').innerText()}"` })
await shown
```

A failed check still waits out its timeout (5 s) before the run moves on, which makes the video longer. Pass a shorter timeout to the assertion (`toBeVisible({ timeout: 2000 })`) where a long wait adds nothing.

### 5. Before and after

For a fix or a change to existing behaviour, record the same script against the old version:

1. Check out the base in a separate worktree: `git worktree add "$QA_DIR/base" <base-commit>` (for a PR, the merge base with its target branch). Install its dependencies and start it on a different port. Don't stash or switch branches in the person's working tree.
2. Run the identical script with only the URL and output folder changed (read them from environment variables). Same data, same frozen clock, same viewport, same stubs.
3. Combine the two results: `node <skill dir>/scripts/qa-run.mjs pair after/result.json before/result.json` prints the show_video input with `path`, `compare`, `qa: "deep"`, `checks`, `compare_checks` and `changes`. It warns when the two runs don't have the same check names.

A check that proves the fix should be red in the before run and green in the after run. If it is green in both, it doesn't prove the fix; rewrite it until it would have caught the bug.

### 6. Report honestly

Show the video with show_video and the helper's output, which includes `qa: "deep"` so the player labels it **Deep QA**:

```json
{ "path": ".../after/run.webm", "compare": ".../before/run.webm",
  "checks": [...], "compare_checks": [...], "changes": [...] }
```

- **Never weaken an assertion to make it pass.** If a check fails, the report says so; fix the code or report the bug, not the test.
- **Failures in bug-report form.** `expected` and `actual` are concrete facts: `URL path /welcome` vs `URL is /welcom (page heading "Not found")`. Use the `actual` option to read the real value off the page. No guesses about causes in those fields; put a cause you verified in `detail`.
- **Only report checks that ran.** Every check needs a command or measurement behind it. Don't list things you looked at in passing or assumed.
- **Automated accessibility is partial.** An axe pass means only the rules it can detect passed, which is part of WCAG, not all of it. Say that when you report it; keyboard and screen reader use still need a person.
- In your reply, lead with what failed, then what passed, in a sentence or two. The player shows the details.

### 7. Clean up

- Close every browser (`run.finish()` does), stop the dev servers you started, and remove any worktree you added (`git worktree remove`).
- Keep recordings and QA scripts in a temp folder, never in the project.
- Save the setup that worked (start command, port, test login, env vars, anything you had to stub) in the project's own notes, such as its CLAUDE.md or AGENTS.md, so the next run starts straight away. Ask before writing to a tracked file if the project's rules say so.

## The helper's API

```js
import { startRun } from '<skill dir>/scripts/qa-run.mjs'
const run = await startRun({ url, outDir, viewport, clock, ignoreConsole, contextOptions, projectDir })
run.page, run.context, run.expect          // expect: @playwright/test's if installed, else a small retrying one
run.step('Pick dates')                     // plan step for the checks that follow
await run.check(name, async fn, { expected, actual, step, detail, url })  // never throws; returns ok
await run.change(title, locator?)          // stamps now, or when locator first shows
await run.axe(name?, { include })          // WCAG A/AA scan if @axe-core/playwright is installed, else skipped
const result = await run.finish()          // console check, close, saves <outDir>/run.webm and result.json
```

Run the QA script from the project's root so Playwright is resolved from the project. If the project has no Playwright, don't add it to its dependencies unasked: install it into the QA temp folder and pass `projectDir` (see `reference/setup.md`).
