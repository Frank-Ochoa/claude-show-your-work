// qa-run.mjs: record a headless Playwright run and time every check against the video.
//
//   import { startRun } from '<skill dir>/scripts/qa-run.mjs'
//   const run = await startRun({ url, outDir })
//   run.step('Sign up')
//   await run.check('Typing "maya@" shows "Enter a valid email"', () => run.expect(run.page.getByText('Enter a valid email')).toBeVisible(), { expected: '"Enter a valid email" under the field' })
//   await run.change('Inline email validation', run.page.getByText('Enter a valid email'))
//   await run.finish()
//
// CLI: node qa-run.mjs pair <after/result.json> <before/result.json>  prints show_video input for a before/after.
//
// Playwright (and @playwright/test, @axe-core/playwright when present) are loaded from the project
// being tested (the current folder, or `projectDir`), never from this skill's folder.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Import a package as the project would resolve it; null when it isn't installed.
async function fromProject(name, dir) {
  try {
    const file = createRequire(path.join(dir, 'package.json')).resolve(name)
    const mod = await import(pathToFileURL(file).href)
    return mod.default && !mod.chromium && !mod.expect ? mod.default : mod
  } catch { return null }
}

const strip = s => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '') // ANSI colours from Playwright errors
const round = n => Math.round(n * 10) / 10

// Turn a Playwright/assertion error into one readable line: the received value, not the call log.
function actualOf(err) {
  const text = strip(err?.message ?? err).split('\n').map(l => l.trim()).filter(Boolean)
  const pick = re => text.find(l => re.test(l))
  const received = pick(/^Received( string| value)?:/)
  if (received) {
    const value = received.replace(/^Received( string| value)?:\s*/, '')
    return /^"no element matches/.test(value) ? `${JSON.parse(value).replace(/^no/, 'No')} before the timeout` : `Got ${value}`
  }
  const locator = pick(/^Locator:/)
  if (pick(/element\(s\) not found|waiting for/) && locator) return `Nothing matched ${locator.replace(/^Locator:\s*/, '')} before the timeout`
  return text.find(l => !/^(Call log|Error:\s*$)/.test(l))?.replace(/^Error:\s*/, '').slice(0, 300) ?? 'Failed'
}

// A small retrying expect for projects with plain `playwright` and no @playwright/test.
// Same names and messages as Playwright's web-first assertions, for the common cases.
function miniExpect(target, { timeout: base = 5000 } = {}) {
  const name = String(target).replace(/^Locator@/, '')
  const missing = `no element matches ${name}`
  const poll = async (label, read, ok, not, opts = {}) => {
    const end = Date.now() + (opts.timeout ?? base)
    let got
    for (;;) {
      try { got = await read() } catch (e) { got = `(error: ${strip(e.message).split('\n')[0]})` }
      if (Boolean(ok(got)) !== not) return
      if (Date.now() > end) throw new Error(`expect(${name}).${not ? 'not.' : ''}${label} failed\nReceived: ${JSON.stringify(got)}`)
      await new Promise(r => setTimeout(r, 100))
    }
  }
  // Reads never wait on their own (Playwright's would wait 30 s for a missing element); the poll does the waiting.
  const el = fn => async () => ((await target.count()) === 0 ? missing : fn(target.first()))
  const state = el(async t => ((await t.isVisible()) ? 'visible' : 'hidden'))
  const text = el(async t => (await t.innerText({ timeout: 500 })).trim())
  const has = (got, want) => got !== missing && (want instanceof RegExp ? want.test(got) : got === want)
  const make = not => ({
    toBeVisible: o => poll('toBeVisible()', state, v => v === 'visible', not, o),
    toBeHidden: o => poll('toBeHidden()', state, v => v !== 'visible', not, o),
    toBeEnabled: o => poll('toBeEnabled()', el(t => t.isEnabled({ timeout: 500 })), v => v === true, not, o),
    toHaveText: (want, o) => poll(`toHaveText(${want})`, text, v => has(v, want), not, o),
    toContainText: (want, o) => poll(`toContainText(${want})`, text, v => v !== missing && (want instanceof RegExp ? want.test(v) : v.includes(want)), not, o),
    toHaveValue: (want, o) => poll(`toHaveValue(${want})`, el(t => t.inputValue({ timeout: 500 })), v => has(v, want), not, o),
    toBeFocused: o => poll('toBeFocused()', el(t => t.evaluate(e => e === document.activeElement)), v => v === true, not, o),
    toHaveCount: (want, o) => poll(`toHaveCount(${want})`, () => target.count(), v => v === want, not, o),
    toHaveURL: (want, o) => poll(`toHaveURL(${want})`, () => target.url(), v => (want instanceof RegExp ? want.test(v) : v === want || v.endsWith(want)), not, o),
  })
  return Object.assign(make(false), { not: make(true) })
}

/**
 * Open a fresh, isolated, recorded browser context.
 * @param {object} o
 * @param {string} [o.url]          page to open first (waits for load, then up to 5 s for network idle)
 * @param {{width:number,height:number}} [o.viewport]  default 1280x800; the video is the same size
 * @param {string} [o.outDir]       where the video and result.json go (default: a new temp folder)
 * @param {string} [o.name]         file name for the video, default "run"
 * @param {boolean} [o.headless]    default true; keep it
 * @param {string|number|Date} [o.clock]  freeze time here (context.clock.install) so dates render the same in every run
 * @param {(string|RegExp)[]} [o.ignoreConsole]  console errors to leave out of the console check (e.g. a known third-party warning)
 * @param {object} [o.contextOptions]  extra browser.newContext options (storageState, locale, colorScheme...)
 * @param {string} [o.projectDir]   where to resolve playwright from (default: process.cwd())
 */
export async function startRun(o = {}) {
  const dir = path.resolve(o.projectDir ?? process.cwd())
  const pwTest = await fromProject('@playwright/test', dir)
  const pw = pwTest?.chromium ? pwTest : await fromProject('playwright', dir)
  if (!pw?.chromium) {
    console.error(`qa-run: Playwright isn't installed in ${dir}. Install it in a temp folder (npm i --prefix <dir> playwright, then npx playwright install chromium --only-shell there) and pass projectDir: '<dir>'`)
    process.exit(1)
  }
  const viewport = o.viewport ?? { width: 1280, height: 800 }
  const outDir = path.resolve(o.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qa-run-')))
  fs.mkdirSync(outDir, { recursive: true })
  const rawDir = fs.mkdtempSync(path.join(outDir, '.raw-'))

  const browser = await pw.chromium.launch({ headless: o.headless ?? true })
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, ...o.contextOptions,
    recordVideo: { dir: rawDir, size: viewport },
  })
  if (o.clock != null) await context.clock.install({ time: o.clock })

  const consoleErrors = []
  const ignored = t => (o.ignoreConsole ?? []).some(p => (p instanceof RegExp ? p.test(t) : t.includes(p)))
  const watch = p => {
    p.on('console', m => { if (m.type() === 'error' && !ignored(m.text())) consoleErrors.push(m.text()) })
    p.on('pageerror', e => { if (!ignored(e.message)) consoleErrors.push(`Uncaught ${e.message}`) })
  }
  context.on('page', watch)

  // The video starts when the page is created; every `at` counts from here.
  const t0 = performance.now()
  const page = await context.newPage()
  const now = () => round(Math.max(0, performance.now() - t0) / 1000)
  // Playwright 1.59+ can draw the clicked element and action name into the video.
  if (o.showActions !== false && typeof page.screencast?.showActions === 'function') {
    await page.screencast.showActions({ position: 'top-right' }).catch(() => {})
  }
  if (o.url) {
    await page.goto(o.url, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}) // dev servers with live sockets never go idle
  }

  const checks = [], changes = []
  let step

  const run = {
    browser, context, page, outDir, viewport,
    expect: pwTest?.expect ?? miniExpect,
    now,
    /** Name the plan step the next checks belong to. */
    step(name) { step = name },

    /**
     * Run one assertion. Never throws: a failure is recorded and the run goes on, so one run reports every failure.
     * opts.expected: what should happen (required for a useful failure)
     * opts.actual:   a string, or an async function reading the real value when the check fails (e.g. () => page.url())
     */
    async check(name, fn, opts = {}) {
      const c = { name, ok: true }
      // A pass is timed when it resolved; a failure when the check began, the
      // moment the thing it looked for should have been on screen. (Timed at
      // the timeout, clicking it would jump seconds past the failure.)
      const began = now()
      try { await fn() } catch (err) {
        c.ok = false
        c.at = began
        c.expected = opts.expected ?? 'The assertion to pass'
        let actual = actualOf(err)
        if (typeof opts.actual === 'function') { try { actual = String(await opts.actual()) } catch {} }
        else if (opts.actual) actual = opts.actual
        c.actual = actual
      }
      c.at ??= now()
      if (opts.step ?? step) c.step = opts.step ?? step
      if (opts.detail) c.detail = opts.detail
      if (opts.url) c.url = opts.url
      checks.push(c)
      console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.at.toFixed(1)}s  ${name}${c.ok ? '' : `\n     expected: ${c.expected}\n     actual:   ${c.actual}`}`)
      return c.ok
    },

    /**
     * Stamp a change. With a locator, stamps the moment it becomes visible; start it (without await) before the
     * action that reveals it, and await it after. A change that never shows is left out and logged.
     */
    async change(title, locator, opts = {}) {
      if (locator) {
        try { await locator.first().waitFor({ state: 'visible', timeout: opts.timeout ?? 5000 }) } catch {
          console.log(`qa-run: change "${title}" never showed; not stamped`)
          return false
        }
      }
      changes.push({ title, at: now(), ...(opts.detail ? { detail: opts.detail } : {}) })
      return true
    },

    /** WCAG A/AA scan with @axe-core/playwright, when the project has it. Returns null (and reports nothing) otherwise. */
    async axe(name = 'The page has no WCAG A/AA violations axe can detect', opts = {}) {
      const mod = await fromProject('@axe-core/playwright', dir)
      const Axe = mod?.AxeBuilder ?? mod?.default ?? mod
      if (typeof Axe !== 'function') { console.log('qa-run: @axe-core/playwright not installed; accessibility scan skipped and not reported'); return null }
      let builder = new Axe({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      if (opts.include) builder = builder.include(opts.include)
      const { violations } = await builder.analyze()
      const summary = violations.map(v => `${v.id} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`).join(', ')
      return run.check(name, () => { if (violations.length) throw new Error(summary) }, {
        step: 'Extras', expected: 'No WCAG A/AA violations', actual: summary, detail: 'Automated checks catch only part of WCAG; keyboard and screen reader use still need a person.',
      })
    },

    /** Close everything, save the video and result.json, print what show_video needs. */
    async finish() {
      // Console errors are reported only when they are a problem of their own:
      // the run otherwise passed. A broken page's errors are the same bug.
      const errs = [...consoleErrors]
      if (errs.length && checks.every(k => k.ok)) await run.check('No console errors or uncaught exceptions during the run', () => { throw new Error(errs[0]) }, {
        step: 'Extras', expected: 'No console errors', actual: `${errs.length} error${errs.length === 1 ? '' : 's'}: ${errs.slice(0, 3).map(e => e.slice(0, 160)).join(' | ')}`,
      })
      const video = page.video()
      await context.close() // the video file is only complete after this
      const file = path.join(outDir, `${o.name ?? 'run'}.webm`)
      await video.saveAs(file)
      await browser.close()
      fs.rmSync(rawDir, { recursive: true, force: true })
      const result = { video: file, viewport, checks, changes, consoleErrors }
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
      const failed = checks.filter(c => !c.ok).length
      console.log(`\nVideo: ${file}\n${checks.length - failed}/${checks.length} checks passed. show_video input:\n${JSON.stringify({ path: file, qa: 'deep', checks, changes })}`)
      return result
    },
  }
  return run
}

// `node qa-run.mjs pair after/result.json before/result.json`: one show_video input for a before/after.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, afterFile, beforeFile] = process.argv.slice(2)
  if (cmd !== 'pair' || !afterFile || !beforeFile) {
    console.error('usage: node qa-run.mjs pair <after/result.json> <before/result.json>')
    process.exit(1)
  }
  const [after, before] = [afterFile, beforeFile].map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
  const names = new Set(before.checks.map(c => c.name))
  const missing = after.checks.filter(c => !names.has(c.name)).map(c => c.name)
  if (missing.length) console.error(`qa-run: the before run has no check named: ${missing.join('; ')}. Run the same script on both sides.`)
  console.log(JSON.stringify({ path: after.video, compare: before.video, qa: 'deep', checks: after.checks, compare_checks: before.checks, changes: after.changes }, null, 2))
}
