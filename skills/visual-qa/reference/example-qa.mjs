// Example Deep QA run. The task: check the email as it's typed on the sign-up form.
// Its success criteria, and nothing else:
//   1. A wrong email is caught as you type.
//   2. A correct email gets you to the welcome page, signed up.
// Same script for both sides of a before/after; only the URL and output folder change:
//   QA_URL=http://localhost:3000 QA_OUT=$QA_DIR/after  node $QA_DIR/qa-signup.mjs
//   QA_URL=http://localhost:3001 QA_OUT=$QA_DIR/before node $QA_DIR/qa-signup.mjs
//   node <skill dir>/scripts/qa-run.mjs pair $QA_DIR/after/result.json $QA_DIR/before/result.json
import { startRun } from '<skill dir>/scripts/qa-run.mjs'

const run = await startRun({ url: process.env.QA_URL, outDir: process.env.QA_OUT })
const { page, expect } = run
const email = page.getByLabel('Email')

const shown = run.change('Email is checked as you type', page.getByText('Enter a valid email'))
await email.click()
await email.pressSequentially('maya@', { delay: 80 })
await run.check('A wrong email is caught as you type: "maya@" shows "Enter a valid email"',
  () => expect(page.getByRole('alert')).toHaveText('Enter a valid email', { timeout: 2000 }),
  { expected: '"Enter a valid email" under the field', actual: async () => `message: "${await page.getByRole('alert').innerText()}"` })
await shown

await email.pressSequentially('example.com', { delay: 60 })
await page.getByRole('button', { name: 'Continue' }).click()
await run.check('A correct email gets you to the welcome page, signed up as maya@example.com',
  () => expect(page.getByText('Signed up as maya@example.com')).toBeVisible({ timeout: 2000 }),
  { expected: 'the welcome page saying "Signed up as maya@example.com"', actual: async () => `went to ${new URL(page.url()).pathname}, page says "${await page.locator('h1').first().innerText()}"` })

await run.finish()
