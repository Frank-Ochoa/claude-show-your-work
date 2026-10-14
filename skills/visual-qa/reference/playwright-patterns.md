# Playwright patterns for QA runs

Parts of this file adapt ideas from Anthropic's `webapp-testing` skill (github.com/anthropics/skills, Apache License 2.0): reconnaissance before action, waiting for the page to settle before reading the DOM, and starting the server separately from the test script.

## Recon before assertions

Look at the real page before writing locators:

```js
const run = await startRun({ url })
await run.page.screenshot({ path: `${QA_DIR}/recon.png`, fullPage: true })
console.log(await run.page.locator('body').ariaSnapshot())   // roles and accessible names
```

Throw away the recon run (or reuse it as a first look) and write the script from what you saw.

## Locators, in order of preference

1. `page.getByRole('button', { name: 'Continue' })`
2. `page.getByLabel('Email')`, `page.getByPlaceholder(...)`
3. `page.getByText('4 nights')`
4. `page.getByTestId('summary')` when the project uses test ids
5. CSS or XPath, only when nothing above works. Say why in a comment.

Scope to a region to avoid ambiguity: `page.getByRole('dialog').getByRole('button', { name: 'Save' })`.

## Waiting

- Assertions retry: `await run.expect(locator).toBeVisible()`. Use them instead of reading a value once.
- Actions (`click`, `fill`) wait for the element to be actionable.
- After a navigation: `await page.waitForURL('**/welcome')` or assert `toHaveURL`.
- After a request: `await page.waitForResponse(r => r.url().includes('/api/save') && r.ok())`.
- `page.waitForTimeout` only to hold a final frame for the viewer, never to wait for the app.

## Soft checks with real values on failure

```js
await run.check('The cart total shows $42.00 after adding two mugs',
  () => run.expect(page.getByTestId('total')).toHaveText('$42.00'),
  { expected: 'Total $42.00', actual: async () => `Total ${await page.getByTestId('total').innerText()}` })
```

`actual` as a function runs only when the check fails and reads the real value off the page.

## Stubbing third parties

```js
await run.context.route(/googletagmanager|segment\.io|sentry\.io/, r => r.abort())
await run.context.route('**/api/payments/intent', r => r.fulfill({ json: { id: 'pi_test', status: 'requires_confirmation' } }))
```

Stub only what is outside the change under test. Don't stub the code you are verifying.

## Deterministic output

```js
const run = await startRun({ url, clock: '2026-05-01T10:00:00Z' })   // Date and timers start here
await run.context.addInitScript(() => { let s = 42; Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646 })
```

Use the same clock, seed and data for the before and after runs. Add the init script before `page.goto`, or reload after adding it.

## Video pacing

- Type with `pressSequentially(text, { delay: 60 })` so the viewer can read it.
- Hold the end state 0.5 to 1 s before `finish()`.
- A failed assertion waits for its timeout; pass `{ timeout: 2000 }` where 5 s of the same frame adds nothing.
