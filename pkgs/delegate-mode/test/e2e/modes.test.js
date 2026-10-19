import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { before, after, test } from 'node:test'

const run = promisify(execFile)
const url = process.env.DSH_MODE_QA_URL
const session = `delegate-mode-browser-${process.pid}`

async function browser(...args) {
  const { stdout } = await run('agent-browser', ['--session', session, '--json', ...args], { timeout: 30000, maxBuffer: 1024 * 1024 })
  const value = JSON.parse(stdout)
  assert.equal(value.success, true, value.error)
  return value.data
}
const evaluate = async (source) => (await browser('eval', source)).result
const TOGGLE = '.ysm-toggle'
const toggleOn = `document.querySelector('${TOGGLE}')?.getAttribute('aria-checked') === 'true'`
const sessionIdOf = `document.querySelector('${TOGGLE}').dataset.sessionId`
const clickToggle = () => browser('click', TOGGLE)

async function modeRequest(payload) {
  return evaluate(`fetch('/api/session-mode', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'client-request',rpcId:'mode-browser-qa',method:'session-mode',payload:${JSON.stringify(payload)}}) }).then(r=>r.json()).then(r=>r.result)`)
}

before(async () => {
  if (!url) return
  const target = new URL(url)
  assert.notEqual(target.port, '3080', 'Use isolated data, never the production GUI')
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
  await browser('open', url)
  await browser('wait', '--fn', `document.body.innerText.includes('Preview Notice') || Boolean(document.querySelector('${TOGGLE}'))`)
  if (await evaluate(`document.body.innerText.includes('Preview Notice')`)) {
    await browser('find', 'role', 'button', 'click', '--name', 'Continue', '--exact')
  }
  await browser('wait', `${TOGGLE}:not(:disabled)`)
  // The mode is durable server state, so normalize it: a repeat run must not
  // inherit the previous run's selection and fail its initial-state assertion.
  const id = await evaluate(sessionIdOf)
  const current = await modeRequest({ v: 1, op: 'read', sessionId: id })
  if (current.value.mode !== 'normal') {
    const reset = await modeRequest({ v: 1, op: 'set', sessionId: id, mode: 'normal', revision: current.value.revision })
    assert.equal(reset.ok, true, `could not normalize the session mode: ${JSON.stringify(reset)}`)
    // The policy is not carried by a Session event, so an out-of-band write is
    // not pushed to this page; a reload is what shows the committed state.
    await browser('reload')
    await browser('wait', `${TOGGLE}:not(:disabled)`)
    await browser('wait', '--fn', `!(${toggleOn})`)
  }
}, { timeout: 90000 })
after(async () => { if (url) await browser('close') })

test('the toggle sits in the toolbar next to the permission control', { skip: !url, timeout: 60000 }, async () => {
  const layout = await evaluate(`(() => {
    const toggle=document.querySelector('${TOGGLE}');
    const permission=[...document.querySelectorAll('button')].find(b=>/Write|权限|Access mode/i.test(b.getAttribute('aria-label')||''));
    if(!toggle) return {missing:true};
    const t=toggle.getBoundingClientRect();
    const row=toggle.parentElement.getBoundingClientRect();
    const tools=toggle.closest('[class*=tools]')||toggle.parentElement;
    const buttons=[...tools.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.getBoundingClientRect());
    const tops=new Set(buttons.map(b=>Math.round(b.top)));
    return {missing:false,toggleLeft:Math.round(t.left),permissionRight:permission?Math.round(permission.getBoundingClientRect().right):null,
      afterPermission:permission?t.left>=permission.getBoundingClientRect().right-1:null,
      sameRow:tops.size<=1,rowHeight:Math.round(row.height),
      label:toggle.innerText.trim(),title:toggle.getAttribute('title'),htmlLang:document.documentElement.lang};
  })()`)
  assert.equal(layout.missing, false)
  assert.equal(layout.afterPermission, true, `toggle must sit right of the permission control: ${JSON.stringify(layout)}`)
  assert.equal(layout.sameRow, true, `toolbar stays one line: ${JSON.stringify(layout)}`)
  // The visible copy is translated, never the raw policy identifier.
  assert.equal(/delegate-writes|normal/.test(layout.label), false, `label must be localized: ${layout.label}`)
  assert.ok(layout.label.length > 0, 'the toggle carries a visible label')
  // The tooltip states the condition and places no unresolved placeholder.
  assert.equal(/\{[a-z]+\}/.test(layout.title ?? ''), false, `title placeholders must resolve: ${layout.title}`)
  assert.ok(/On|Off|已开启|已关闭/.test(layout.title ?? ''), `title states the switch state: ${layout.title}`)
})

test('blank sessions toggle delegate mode and reject stale revision writes', { skip: !url, timeout: 60000 }, async () => {
  assert.equal(await evaluate(toggleOn), false)
  const id = await evaluate(sessionIdOf)
  const initial = await modeRequest({ v: 1, op: 'read', sessionId: id })
  assert.equal(initial.value.mode, 'normal')
  await clickToggle()
  await browser('wait', '--fn', toggleOn)
  assert.equal((await modeRequest({ v: 1, op: 'read', sessionId: id })).value.mode, 'delegate-writes')
  const stale = await modeRequest({ v: 1, op: 'set', sessionId: id, mode: 'normal', revision: initial.value.revision })
  assert.equal(stale.value.code, 'conflict')
  assert.equal(await evaluate(toggleOn), true, 'a rejected save leaves the toggle on')
  await clickToggle()
  await browser('wait', '--fn', `!(${toggleOn})`)
})

test('the toggle fits and stays clickable on desktop and mobile viewports', { skip: !url, timeout: 60000 }, async () => {
  for (const [width, height] of [[1440, 900], [768, 1024], [375, 812]]) {
    await browser('set', 'viewport', String(width), String(height))
    const result = await evaluate(`(() => {
      const t=document.querySelector('${TOGGLE}');const r=t.getBoundingClientRect();
      return {inViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
        fits:t.scrollWidth<=t.clientWidth+1,
        clickable:t.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    })()`)
    assert.equal(result.inViewport, true, `${width}x${height}`)
    assert.equal(result.fits, true, `${width}x${height} label clipped`)
    assert.equal(result.clickable, true, `${width}x${height} not clickable`)
  }
  await browser('screenshot', '/tmp/dsh-delegate-mode-mobile.png')
})

test('saved mode remains addressable after browser reload', { skip: !url, timeout: 60000 }, async () => {
  const id = await evaluate(sessionIdOf)
  await clickToggle()
  await browser('wait', '--fn', toggleOn)
  await browser('reload')
  await browser('wait', `${TOGGLE}:not(:disabled)`)
  const saved = await modeRequest({ v: 1, op: 'read', sessionId: id })
  assert.equal(saved.value.mode, 'delegate-writes')
})
