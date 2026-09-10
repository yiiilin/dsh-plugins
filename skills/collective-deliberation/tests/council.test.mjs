import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateScores,
  combineResults,
  parseCombinedJson,
  parseCombinedResults,
  parseMemberResult,
  parseVoteCsv,
  renderCombinedResults,
} from '../scripts/council.mjs';

const result = (title, claim) => ({
  title,
  claim,
  evidence: ['题面材料'],
  uncertainties: ['尚未运行外部验证'],
  verification: '运行对应的确定性检查',
});
const memberText = (dispatchId, ...results) => JSON.stringify({ dispatchId, results });
const members = ['member-a', 'member-b', 'member-c', 'member-d'];

function combinedFixture() {
  return combineResults(members.map((dispatchId, index) => ({
    dispatchId,
    results: [result(`结果 ${index + 1}`, `主张 ${index + 1}`)],
  })));
}

function voteText(scores) {
  return scores.map(([resultNo, score]) => `${resultNo},${score}`).join('\n');
}

test('member files require one exact JSON object and matching dispatch id', () => {
  const parsed = parseMemberResult(memberText('member-a', result('标题', '主张')), 'member-a');
  assert.equal(parsed.dispatchId, 'member-a');
  assert.equal(parsed.results.length, 1);
  assert.throws(() => parseMemberResult('```json\n{}\n```', 'member-a'), /not JSON/);
  assert.throws(() => parseMemberResult(memberText('member-b', result('标题', '主张')), 'member-a'), /dispatchId mismatch/);
  assert.throws(() => parseMemberResult(JSON.stringify({ dispatchId: 'member-a', results: [] }), 'member-a'), /1-32/);
});

test('combine assigns stable contiguous result numbers by dispatch id', () => {
  const combined = combineResults([
    { dispatchId: 'member-c', results: [result('C', 'c')] },
    { dispatchId: 'member-a', results: [result('A1', 'a1'), result('A2', 'a2')] },
    { dispatchId: 'member-b', results: [result('B', 'b')] },
  ]);
  assert.deepEqual(combined.map(item => [item.resultNo, item.sourceDispatchId, item.title]), [
    [1, 'member-a', 'A1'],
    [2, 'member-a', 'A2'],
    [3, 'member-b', 'B'],
    [4, 'member-c', 'C'],
  ]);
  assert.throws(() => combineResults([{ dispatchId: 'member-a', results: [result('A', 'a')] }, { dispatchId: 'member-a', results: [result('A2', 'a2')] }]), /duplicate/);
});

test('combined markdown round-trips only its marked JSON section', () => {
  const source = combinedFixture();
  const parsed = parseCombinedResults(renderCombinedResults(source));
  assert.deepEqual(parsed, source);
  assert.throws(() => parseCombinedResults('# Combined Results\n[]'), /markers/);
  const malformed = renderCombinedResults(source).replace('"resultNo": 1', '"resultNo": 2');
  assert.throws(() => parseCombinedResults(malformed), /unique|contiguous/);
});

test('vote CSV is headerless, exactly two columns, and covers every result', () => {
  const expected = [1, 2, 3];
  assert.deepEqual(parseVoteCsv('1,5\n2,3\n3,0\n', expected), [
    { resultNo: 1, score: 5 },
    { resultNo: 2, score: 3 },
    { resultNo: 3, score: 0 },
  ]);
  assert.throws(() => parseVoteCsv('resultNo,score\n2,3\n3,0', expected), /header/);
  assert.throws(() => parseVoteCsv('1,5\n2,3\n2,0', expected), /match the combine/);
  assert.throws(() => parseVoteCsv('1,5,extra\n2,3\n3,0', expected), /two columns/);
  assert.throws(() => parseVoteCsv('1,5\n2,3.5\n3,0', expected), /invalid score/);
});

test('score calculation excludes authors and preserves missing or invalid vote files', () => {
  const combined = combinedFixture();
  const votes = {
    'member-a': voteText([[1, 0], [2, 5], [3, 3], [4, 4]]),
    'member-b': voteText([[1, 5], [2, 0], [3, 3], [4, 3]]),
    'member-c': voteText([[1, 4], [2, 2], [3, 3], [4, 3]]),
    'member-d': voteText([[1, 4], [2, 5], [3, 3], [4, 3]]),
  };
  const scored = calculateScores({ results: combined, dispatchIds: members, votesByDispatch: votes });
  assert.deepEqual(scored.results.map(item => item.status), ['candidate', 'needs_review', 'below_threshold', 'below_threshold']);
  assert.equal(scored.results[0].validVotes, 3);
  assert.equal(scored.results[0].mean, 13 / 3);
  assert.deepEqual(scored.results[0].scores.map(item => item.dispatchId), ['member-b', 'member-c', 'member-d']);

  const incomplete = calculateScores({ results: combined, dispatchIds: members, votesByDispatch: { ...votes, 'member-d': undefined } });
  assert.equal(incomplete.voteStatuses.find(item => item.dispatchId === 'member-d').status, 'missing');
  assert.equal(incomplete.results[0].status, 'insufficient_votes');

  const invalid = calculateScores({ results: combined, dispatchIds: members, votesByDispatch: { ...votes, 'member-c': 'bad' } });
  assert.equal(invalid.voteStatuses.find(item => item.dispatchId === 'member-c').status, 'invalid');
  assert.equal(invalid.results[0].status, 'insufficient_votes');
});

test('combine uses ASCII ordering for mixed-case, numeric, hyphen and underscore IDs', () => {
  const ids = ['a_', 'a0', 'a-', 'a', 'Z', 'A_', 'A0', 'A-', 'A', '9'];
  const combined = combineResults(ids.map(id => ({ dispatchId: id, results: [result(id, id)] })));
  assert.deepEqual(combined.map(item => item.sourceDispatchId), ['9', 'A', 'A-', 'A0', 'A_', 'Z', 'a', 'a-', 'a0', 'a_']);
  assert.deepEqual(parseCombinedJson(JSON.stringify(combined), ids), combined);
});

test('canonical validation applies equally to direct scoring and JSON parsing', () => {
  const source = combinedFixture();
  const malformedBoards = {
    empty: [],
    duplicate: source.map((item, index) => ({ ...item, resultNo: index === 1 ? 1 : item.resultNo })),
    gap: source.map((item, index) => ({ ...item, resultNo: index === 3 ? 5 : item.resultNo })),
    unknownAuthor: source.map((item, index) => ({ ...item, sourceDispatchId: index === 3 ? 'member-z' : item.sourceDispatchId })),
    missingAuthor: source.slice(0, -1),
    unsortedAuthors: [source[1], source[0], ...source.slice(2)].map((item, index) => ({ ...item, resultNo: index + 1 })),
    unsortedNumbers: [source[1], source[0], ...source.slice(2)],
  };
  for (const [label, results] of Object.entries(malformedBoards)) {
    assert.throws(() => parseCombinedJson(JSON.stringify(results), members), undefined, `parseCombinedJson: ${label}`);
    assert.throws(() => calculateScores({ results, dispatchIds: members, votesByDispatch: {} }), undefined, `calculateScores: ${label}`);
  }
});

test('CSV numbers require canonical decimal tokens without whitespace or coercion', () => {
  const invalidResultNos = ['', ' ', ' 1', '1 ', '\t1', '1e0', '0x1', '+1', '-1', '+0', '-0', '0', '1.0', '01', '9007199254740992'];
  for (const token of invalidResultNos) {
    assert.throws(() => parseVoteCsv(`${token},5`, [1]), /invalid resultNo/, `resultNo ${JSON.stringify(token)}`);
  }
  const invalidScores = ['', ' ', ' 5', '5 ', '\t5', '5e0', '0x5', '+5', '-1', '+0', '-0', '5.0', '05', '6'];
  for (const token of invalidScores) {
    assert.throws(() => parseVoteCsv(`1,${token}`, [1]), /invalid score/, `score ${JSON.stringify(token)}`);
  }
  assert.throws(() => parseVoteCsv('1,5\n\n', [1]));
  assert.deepEqual(parseVoteCsv('1,0\r\n', [1]), [{ resultNo: 1, score: 0 }]);
});

test('five-member quorum still needs review for missing or invalid votes, including author votes', () => {
  const ids = [...members, 'member-e'];
  const results = combineResults(ids.map(id => ({ dispatchId: id, results: [result(id, id)] })));
  const fullVote = voteText(results.map(item => [item.resultNo, 5]));
  const votes = Object.fromEntries(ids.map(id => [id, fullVote]));
  for (const anomalousId of ['member-a', 'member-e']) {
    for (const [status, value] of [['missing', undefined], ['invalid', '1,5e0']]) {
      const scored = calculateScores({ results, dispatchIds: ids, votesByDispatch: { ...votes, [anomalousId]: value } });
      const first = scored.results[0];
      assert.equal(scored.requiredVotes, 3);
      assert.equal(first.validVotes, anomalousId === 'member-a' ? 4 : 3);
      assert.equal(first.qualifies, true);
      assert.equal(first.status, 'needs_review');
      assert.equal(scored.voteStatuses.find(item => item.dispatchId === anomalousId).status, status);
      assert.ok(scored.results.every(item => item.status === 'needs_review'));
    }
  }
});

test('recorded failures require review even with unanimous valid votes', () => {
  const results = combinedFixture();
  const votesByDispatch = Object.fromEntries(members.map(id => [id, voteText(results.map(item => [item.resultNo, 5]))]));
  const failures = [{ phase: 'proposal', dispatchId: 'member-a', error: 'first attempt failed' }];
  const scored = calculateScores({ results, dispatchIds: members, votesByDispatch, failures });
  assert.deepEqual(scored.failures, failures);
  assert.ok(scored.results.every(item => item.qualifies && item.status === 'needs_review'));
});

test('the default 3.5 mean threshold is strictly greater than, not inclusive', () => {
  const ids = [...members, 'member-e'];
  const results = combineResults(ids.map(id => ({ dispatchId: id, results: [result(id, id)] })));
  for (const [scores, expectedMean, expectedStatus] of [
    [[3, 3, 3, 4], 3.25, 'below_threshold'],
    [[3, 3, 4, 4], 3.5, 'below_threshold'],
    [[3, 4, 4, 4], 3.75, 'candidate'],
  ]) {
    const votesByDispatch = Object.fromEntries(ids.map((id, index) => [id, voteText(results.map(item => [item.resultNo, index === 0 ? 0 : scores[index - 1]]))]));
    const scored = calculateScores({ results, dispatchIds: ids, votesByDispatch });
    assert.equal(scored.threshold, 3.5);
    assert.equal(scored.results[0].mean, expectedMean);
    assert.equal(scored.results[0].status, expectedStatus);
    assert.equal(scored.results[0].qualifies, expectedMean > 3.5);
  }
});

const script = fileURLToPath(new URL('../scripts/council.mjs', import.meta.url));
const cli = (command, runDir) => JSON.parse(execFileSync(process.execPath, [script, command, runDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const timestamp = '2026-06-01T00:00:00.000Z';
const successfulPhase = () => ({ status: 'ok', attempts: [{ status: 'ok', startedAt: timestamp, endedAt: timestamp }] });
const failedPhase = () => ({ status: 'failed', attempts: Array.from({ length: 3 }, () => ({ status: 'failed', startedAt: timestamp, endedAt: timestamp, error: 'worker failed' })) });

async function withCliFixture(callback, ids = members) {
  const runDir = join('/tmp', `.collective-deliberation-${randomUUID()}`);
  await mkdir(runDir);
  try {
    const manifest = {
      runId: 'test-run',
      topicVersion: 'topic-v1',
      permissionStatus: { status: 'approved' },
      maxRetryAttempts: 2,
      dispatchIds: ids,
      resultFiles: Object.fromEntries(ids.map(id => [id, `tmp-result-${id}.json`])),
      voteFiles: Object.fromEntries(ids.map(id => [id, `vote-${id}.csv`])),
      members: ids.map(dispatchId => ({ dispatchId, sessionId: `session-${dispatchId}`, environmentId: `environment-${dispatchId}`, proposal: successfulPhase(), vote: successfulPhase() })),
      failures: [],
    };
    const saveManifest = () => writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest));
    await saveManifest();
    await Promise.all(ids.map((id, index) => writeFile(join(runDir, manifest.resultFiles[id]), memberText(id, result(`结果 ${index}`, `主张 ${index}`)))));
    await Promise.all(ids.map(id => writeFile(join(runDir, manifest.voteFiles[id]), voteText(ids.map((_, index) => [index + 1, 5])))));
    await callback({ runDir, manifest, saveManifest });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

test('CLI combines member JSON files and scores vote CSV files with complete audit', async () => {
  await withCliFixture(async ({ runDir, manifest }) => {
    assert.equal(cli('combine', runDir).resultCount, 4);
    const finalOutput = cli('score', runDir);
    assert.equal(finalOutput.resultCount, 4);
    const final = JSON.parse(await readFile(join(runDir, 'final-result.json'), 'utf8'));
    assert.equal(final.results.length, 4);
    assert.equal(JSON.parse(await readFile(join(runDir, 'tmp-result-combine.json'), 'utf8')).length, 4);
    assert.equal(final.topicVersion, manifest.topicVersion);
    assert.equal(final.threshold, 3.5);
    assert.equal(final.maxSpread, 2);
    assert.equal(final.requiredVotes, 3);
    assert.deepEqual(final.failures, []);
    assert.deepEqual(final.audit, manifest);
    assert.deepEqual(final.counts, { candidate: 4, needs_review: 0, below_threshold: 0, insufficient_votes: 0 });
    assert.deepEqual(final.outputFiles, { jsonPath: join(runDir, 'final-result.json'), mdPath: join(runDir, 'final-result.md') });
    const expectedPaths = ['manifest.json', ...Object.values(manifest.resultFiles), 'tmp-result-combine.json', 'tmp-result-combine.md', ...Object.values(manifest.voteFiles)].map(path => join(runDir, path));
    assert.deepEqual(final.files.map(file => file.path).sort(), expectedPaths.sort());
    for (const file of final.files) {
      const bytes = await readFile(file.path);
      assert.equal(file.status, 'ok');
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
  });
});

test('CLI rejects canonical content changed after combine even when Markdown agrees', async () => {
  await withCliFixture(async ({ runDir }) => {
    cli('combine', runDir);
    const canonical = JSON.parse(await readFile(join(runDir, 'tmp-result-combine.json'), 'utf8'));
    canonical[0].claim = '篡改后的主张';
    await writeFile(join(runDir, 'tmp-result-combine.json'), JSON.stringify(canonical));
    await writeFile(join(runDir, 'tmp-result-combine.md'), renderCombinedResults(canonical));
    assert.throws(() => cli('score', runDir));
  });
});

test('CLI rejects changed original member results after the canonical board was frozen', async () => {
  await withCliFixture(async ({ runDir, manifest }) => {
    cli('combine', runDir);
    await writeFile(join(runDir, manifest.resultFiles['member-a']), memberText('member-a', result('新标题', '新主张')));
    assert.throws(() => cli('score', runDir));
  });
});

test('CLI requires exact Markdown bytes even when its embedded JSON is unchanged', async () => {
  await withCliFixture(async ({ runDir }) => {
    cli('combine', runDir);
    const path = join(runDir, 'tmp-result-combine.md');
    const original = await readFile(path, 'utf8');
    for (const tampered of [original.replace('# Combined Results', '# Changed Results'), `${original}\n`, original.replaceAll('\n', '\r\n')]) {
      await writeFile(path, tampered);
      assert.throws(() => cli('score', runDir));
    }
  });
});

test('CLI refuses a nonterminal proposal or vote phase', async () => {
  await withCliFixture(async ({ runDir, manifest, saveManifest }) => {
    manifest.members[0].proposal = { status: 'running', attempts: [] };
    await saveManifest();
    assert.throws(() => cli('combine', runDir));
    manifest.members[0].proposal = successfulPhase();
    await saveManifest();
    cli('combine', runDir);
    for (const vote of [{ status: 'pending', attempts: [] }, { status: 'ok', attempts: [{ status: 'running', startedAt: timestamp }] }]) {
      manifest.members[0].vote = vote;
      await saveManifest();
      assert.throws(() => cli('score', runDir));
    }
  });
});

test('CLI ignores CSV left behind by a terminal failed vote and requires review', async () => {
  await withCliFixture(async ({ runDir, manifest, saveManifest }) => {
    manifest.members[4].vote = failedPhase();
    await saveManifest();
    cli('combine', runDir);
    cli('score', runDir);
    const final = JSON.parse(await readFile(join(runDir, 'final-result.json'), 'utf8'));
    assert.equal(final.results[0].validVotes, 3);
    assert.equal(final.results[0].qualifies, true);
    assert.equal(final.results[0].status, 'needs_review');
    assert.ok(final.results.every(item => item.scores.every(vote => vote.dispatchId !== 'member-e')));
    assert.notEqual(final.voteStatuses.find(item => item.dispatchId === 'member-e').status, 'ok');
    assert.ok(final.failures.some(failure => failure.dispatchId === 'member-e'));
  }, [...members, 'member-e']);
});

test('CLI records every vote read error and preserves manifest failures', async () => {
  await withCliFixture(async ({ runDir, manifest, saveManifest }) => {
    const earlierFailure = { dispatchId: 'member-a', phase: 'proposal', error: 'first attempt timed out' };
    manifest.failures.push(earlierFailure);
    await saveManifest();
    cli('combine', runDir);
    await rm(join(runDir, manifest.voteFiles['member-d']));
    await rm(join(runDir, manifest.voteFiles['member-e']));
    await mkdir(join(runDir, manifest.voteFiles['member-e']));
    cli('score', runDir);
    const final = JSON.parse(await readFile(join(runDir, 'final-result.json'), 'utf8'));
    assert.ok(final.failures.some(failure => failure.error === earlierFailure.error));
    for (const [id, code] of [['member-d', 'ENOENT'], ['member-e', 'EISDIR']]) {
      const path = join(runDir, manifest.voteFiles[id]);
      assert.ok(final.failures.some(failure => failure.path === path && failure.code === code && failure.error), `${id} ${code} must be audited`);
      const file = final.files.find(item => item.path === path);
      assert.equal(file.status, 'unreadable');
      assert.equal(file.code, code);
      assert.equal(file.phase, 'vote');
      assert.ok(file.error);
      assert.equal(Object.hasOwn(file, 'sha256'), false);
      assert.notEqual(final.voteStatuses.find(item => item.dispatchId === id).status, 'ok');
    }
    assert.equal(final.results[3].validVotes, 3);
    assert.equal(final.results[3].status, 'needs_review');
  }, [...members, 'member-e']);
});
