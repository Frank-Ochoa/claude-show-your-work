# Extras and light-tier recipes

Each recipe is a measurement. Report it as a check only when you ran it.

## Breakpoints: no horizontal overflow

```js
for (const width of [375, 768, 1280]) {
  await page.setViewportSize({ width, height: 800 })
  await run.check(`At ${width} px the page has no horizontal scroll`,
    async () => { const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]); if (sw > cw) throw new Error(`Received: scrollWidth ${sw} > clientWidth ${cw}`) },
    { step: 'Extras', expected: 'scrollWidth <= clientWidth' })
}
```

Changing the viewport mid-run doesn't resize the video; for a breakpoint video, run `startRun({ viewport: { width: 375, height: 812 } })` separately.

## Keyboard-only pass

Reach and use the new control with Tab, Shift+Tab, Enter, Space and Escape only:

```js
await page.keyboard.press('Tab')
await run.check('Tab moves focus to the Continue button', () => run.expect(page.getByRole('button', { name: 'Continue' })).toBeFocused(), { step: 'Extras', expected: 'Focus on Continue', actual: () => page.evaluate(() => `Focus on ${document.activeElement?.outerHTML.slice(0, 80)}`) })
```

Also check focus is visible (an outline or ring in the screenshot) and that a dialog returns focus to its trigger when it closes.

## Accessibility scan

`await run.axe('The checkout form has no WCAG A/AA violations axe can detect')` after each meaningful state (form open, error shown, dialog open). It needs `@axe-core/playwright`; without it the helper skips the scan and reports nothing. Automated rules cover only part of WCAG; say so.

Contrast only: `new AxeBuilder({ page }).withRules(['color-contrast']).analyze()`.

## Dark mode

`startRun({ contextOptions: { colorScheme: 'dark' } })`, then repeat the axe scan and a screenshot.

## Charts

Recompute the figure from the source data in the script and compare it with the text drawn:

```js
const rows = JSON.parse(fs.readFileSync('data/sales.json', 'utf8'))
const total = rows.reduce((a, r) => a + r.amount, 0)
await run.check(`The total label reads ${total.toLocaleString('en-US')}`, () => run.expect(page.getByTestId('chart-total')).toHaveText(total.toLocaleString('en-US')), { expected: `Total ${total}` })
```

## Video and image files

```sh
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of default=nw=1 out.mp4
```

Report the measured size and length against the brief (for example `1080x1920, 15.0 s`).
