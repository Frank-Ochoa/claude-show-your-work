// Claude's QA run on the pricing page: a visible cursor and a checklist, so it reads on video.
const { chromium } = require('playwright')
const [, , version, outDir] = process.argv
const HUD = () => {
  const css = document.createElement('style')
  css.textContent = `
  #qa-cursor{position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.92);
    box-shadow:0 0 0 3px rgba(124,92,255,.95),0 4px 14px rgba(0,0,0,.5);pointer-events:none;transition:transform .12s}
  #qa-cursor.down{transform:scale(.65)}
  #qa-hud{position:fixed;z-index:99998;left:20px;top:64px;width:290px;padding:14px 16px;border-radius:12px;background:rgba(8,10,16,.94);
    border:1px solid rgba(255,255,255,.12);font:500 13px/1.5 -apple-system,sans-serif;color:#E8EEFA}
  #qa-hud h4{margin:0 0 6px;font:600 12px -apple-system,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#a48bff}
  #qa-hud .row{display:flex;gap:8px;opacity:0;transform:translateY(4px);transition:all .25s}#qa-hud .row.on{opacity:1;transform:none}
  #qa-hud .ok{color:#4ADE80}#qa-hud .bad{color:#F87171}
  .qa-ok{outline:3px solid #4ADE80!important;outline-offset:4px}.qa-bad{outline:3px solid #F87171!important;outline-offset:4px}`
  document.head.appendChild(css)
  const c = document.createElement('div'); c.id = 'qa-cursor'; document.body.appendChild(c)
  const h = document.createElement('div'); h.id = 'qa-hud'; h.innerHTML = '<h4>Claude QA · pricing</h4>'; document.body.appendChild(h)
  addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' })
  addEventListener('mousedown', () => c.classList.add('down')); addEventListener('mouseup', () => c.classList.remove('down'))
  window.qaLog = (t, ok) => { const r = document.createElement('div'); r.className = 'row'
    r.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span><span>${t}</span>`; h.appendChild(r); requestAnimationFrame(() => r.classList.add('on')) }
}
;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: outDir, size: { width: 1280, height: 720 } } })
  const page = await ctx.newPage()
  const t0 = Date.now(), wait = ms => page.waitForTimeout(ms), glide = (x, y, s = 20) => page.mouse.move(x, y, { steps: s })
  const results = []
  const log = async (name, ok, el) => {
    results.push({ name, ok, at: Math.round((Date.now() - t0) / 100) / 10 })
    if (el) await el.evaluate((n, o) => n.classList.add(o ? 'qa-ok' : 'qa-bad'), ok)
    await page.evaluate(([t, o]) => window.qaLog(t, o), [name, ok]); await wait(900)
    if (el) await el.evaluate(n => n.classList.remove('qa-ok', 'qa-bad'))
  }
  await page.goto('file://' + __dirname + '/pricing.html?v=' + version)
  await page.evaluate(HUD); await page.mouse.move(640, 300); await wait(700)
  const plans = await page.$$('.plan')
  await log('All three plans load', plans.length === 3)
  // Annual billing should lower the prices.
  const sw = await page.$('#billing'); const sb = await sw.boundingBox()
  const before = await page.$$eval('.price', ps => ps.map(p => p.textContent))
  await glide(sb.x + sb.width / 2, sb.y + sb.height / 2); await wait(250)
  await page.mouse.down(); await wait(90); await page.mouse.up(); await wait(600)
  const after = await page.$$eval('.price', ps => ps.map(p => p.textContent))
  const pro = await page.$('.pro .price')
  await glide(640, (await pro.boundingBox()).y + 25, 16)
  await log('Annual toggle updates prices', before[1] !== after[1], pro)
  // Every plan's button should sit on one line.
  const btns = await page.$$('.btn'); const tops = []
  for (const b of btns) { const r = await b.boundingBox(); tops.push(Math.round(r.y)); await glide(r.x + r.width / 2, r.y + r.height / 2, 14); await wait(200) }
  const row = await page.$('.plans')
  await log('Plan buttons line up', new Set(tops).size === 1, row)
  // The Pro button text must be readable (WCAG AA, 4.5:1).
  const proBtn = await page.$('.pro .btn'); const pb = await proBtn.boundingBox()
  await glide(pb.x + pb.width / 2, pb.y + pb.height / 2, 12)
  const ratio = await proBtn.evaluate(el => {
    const rgb = s => s.match(/\d+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
    const L = s => { const [r, g, b] = rgb(s); return .2126 * r + .7152 * g + .0722 * b }
    const s = getComputedStyle(el), a = L(s.color), b = L(s.backgroundColor)
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
  })
  await log('Pro button text readable', ratio >= 4.5, proBtn)
  await log('Most popular badge on Pro', !!(await page.$('.pro .badge')))
  await glide(1100, 160); await wait(1500)
  await ctx.close()
  // a predictable name, next to the checks it ran
  await page.video().saveAs(`${outDir}/${version}.webm`); await page.video().delete()
  require('fs').writeFileSync(`${outDir}/checks.json`, JSON.stringify(results, null, 2))
  await browser.close()
  console.log(JSON.stringify(results))
})()
