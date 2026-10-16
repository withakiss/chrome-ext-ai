import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests, formatTestResult } from '../extension/lib/tests.js';

test('실행 경로 없음·실행기 미설치는 미실행과 사유', async () => {
  assert.equal((await runTests({ templateId: 'unit' })).state, 'notrun');
  const r = await runTests({ testPath: 'C:\\p', templateId: 'unit', send: async () => { throw new Error('Specified native messaging host not found.'); } });
  assert.equal(r.state, 'notrun'); assert.match(r.reason, /설치되지 않았습니다/);
  assert.match((await runTests({ testPath: 'C:\\p', templateId: 'x', send: async () => ({ ok: false, error: '허용되지 않은 템플릿: x' }) })).reason, /허용되지 않은/);
});

test('종료 코드·시간 초과 판정', async () => {
  const ok = await runTests({ testPath: 'C:\\p', templateId: 'unit', send: async (m) => ({ ok: true, command: 'npm.cmd test', exitCode: 0, ms: 3000, stdout: 'pass 3', stderr: '' }) });
  assert.equal(ok.state, 'passed'); assert.match(formatTestResult(ok), /통과.*npm\.cmd test/);
  assert.equal((await runTests({ testPath: 'C:\\p', templateId: 'u', send: async () => ({ ok: true, exitCode: 1, stdout: '' }) })).state, 'failed');
  assert.equal((await runTests({ testPath: 'C:\\p', templateId: 'u', send: async () => ({ ok: true, timedOut: true, exitCode: null }) })).state, 'timeout');
});
