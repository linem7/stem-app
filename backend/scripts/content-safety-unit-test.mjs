import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.js';
import { checkText } from '../src/services/contentSafety.js';
import { streamDelta } from '../src/routes/generate.js';

const saved = { enabled: config.contentSafety.enabled, accessKeyId: config.contentSafety.accessKeyId, accessKeySecret: config.contentSafety.accessKeySecret };
const originalFetch = globalThis.fetch;
Object.assign(config.contentSafety, { enabled: true, accessKeyId: 'test', accessKeySecret: 'test' });
let count = 0;
const normal = { Code: 200, Data: { RiskLevel: 'none', Result: [{ Label: 'nonLabel' }] } };
function response(body) { return { ok: true, json: async () => body }; }
async function unavailable() {
  await assert.rejects(() => checkText({ content: '课堂内容', stage: 'teacher_input' }),
    (e) => e.code === 'CONTENT_CHECK_UNAVAILABLE' && e.http === 503 && e.retryable);
  count++;
}
try {
  for (const body of [null, {}, { Code: 500 }, { Code: 200 }, { Code: 200, Data: { Result: [] } },
    { Code: 200, Data: { Result: [{}] } }, { Code: 200, Data: { RiskLevel: 'unknown', Result: [{ Label: 'nonLabel' }] } }]) {
    globalThis.fetch = async () => response(body);
    await unavailable();
  }
  globalThis.fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await unavailable();
  globalThis.fetch = async () => ({ ok: false });
  await unavailable();
  config.contentSafety.accessKeyId = '';
  globalThis.fetch = async () => { assert.fail('Missing credentials must not call provider'); };
  await unavailable();
  config.contentSafety.accessKeyId = 'test';
  for (const body of [normal, { Code: 200, Data: { RiskLevel: 'none', Result: [] } }]) {
    globalThis.fetch = async () => response(body);
    assert.equal((await checkText({ content: '课堂', stage: 'teacher_input' })).suggest, 'pass'); count++;
  }
  for (const data of [{ RiskLevel: 'high', Result: [] }, { Result: [{ Label: 'contraband_act' }] }]) {
    globalThis.fetch = async () => response({ Code: 200, Data: data });
    assert.equal((await checkText({ content: '样本', stage: 'ai_output' })).pass, false); count++;
  }
  const chunks = [];
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('Service'), 'llm_query_moderation');
    const { content } = JSON.parse(params.get('ServiceParameters'));
    assert.ok(content.length <= 2000 && content.isWellFormed());
    chunks.push(content);
    return response(content.includes('边界测试') ? { Code: 200, Data: { Result: [{ Label: 'risk' }] } } : normal);
  };
  assert.equal((await checkText({ content: '好'.repeat(1998) + '边界测试' + '😀'.repeat(1100), stage: 'teacher_input' })).pass, false);
  assert.equal(chunks.length, 2); count++;
  chunks.length = 0;
  await checkText({ content: '好' + '😀'.repeat(2200), stage: 'teacher_input' });
  assert.equal(chunks.length, 3); count++;
  assert.equal(streamDelta({ text: '尚未审核的正文', epoch: 1 }, {}), null); count++;
  const startup = spawnSync(process.execPath, ['--input-type=module', '-e', "import {assertConfigOrExit} from './src/config.js'; assertConfigOrExit()"], {
    env: { ...process.env, CONTENT_CHECK_ENABLED: 'true', ALIBABA_CLOUD_ACCESS_KEY_ID: '', ALIBABA_CLOUD_ACCESS_KEY_SECRET: '' }, encoding: 'utf8',
  });
  assert.equal(startup.status, 1); assert.match(startup.stderr, /ALIBABA_CLOUD_ACCESS_KEY_ID/); count++;
  console.log(`内容安全异常、分段、流式防泄漏：${count} 项通过`);
} finally {
  globalThis.fetch = originalFetch;
  Object.assign(config.contentSafety, saved);
}
