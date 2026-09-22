import assert from 'node:assert/strict'
import { clearToken, getToken, setToken, get } from '../src/utils/request.js'
import { getMe } from '../src/api/me.js'
import { logout, session } from '../src/stores/session.js'

const originalFetch = globalThis.fetch
function deferredResponse() {
  let resolve
  globalThis.fetch = () => new Promise((r) => { resolve = r })
  return (payload, status = 200) => resolve(new Response(JSON.stringify(payload), { status }))
}
try {
  setToken('account-a')
  session.teacher = { id: 1 }
  session.bootError = new Error('previous network failure')
  let respond = deferredResponse()
  const oldProfile = getMe()
  const rejectedProfile = assert.rejects(oldProfile, { code: 'SESSION_CHANGED' })
  logout()
  respond({ ok: true, data: { id: 1, token: 'renewed-account-a' } })
  await rejectedProfile
  assert.equal(getToken(), '')
  assert.equal(session.teacher, null)
  assert.equal(session.bootError, null)
  console.log('PASS: late profile renewal cannot restore an account after logout')

  setToken('account-a')
  respond = deferredResponse()
  const oldRequest = get('/conversations')
  const rejectedOld = assert.rejects(oldRequest, { code: 'SESSION_CHANGED' })
  logout()
  setToken('account-b')
  session.teacher = { id: 2 }
  respond({ ok: false, error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401)
  await rejectedOld
  assert.equal(getToken(), 'account-b')
  assert.equal(session.teacher.id, 2)
  console.log('PASS: late account-A 401 cannot log account B out')

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { id: 2, token: 'renewed-b' } }))
  assert.deepEqual(await getMe(), { id: 2 })
  assert.equal(getToken(), 'renewed-b')
  console.log('PASS: current-account renewal still works')
} finally {
  globalThis.fetch = originalFetch
  clearToken()
}
