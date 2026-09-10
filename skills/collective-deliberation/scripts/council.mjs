import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_THRESHOLD = 3.5;
export const DEFAULT_MAX_SPREAD = 2;
const COMBINE_BEGIN = '<!-- BEGIN COLLECTIVE RESULTS JSON -->';
const COMBINE_END = '<!-- END COLLECTIVE RESULTS JSON -->';
const RESULT_FIELDS = ['title', 'claim', 'evidence', 'uncertainties', 'verification'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const hasExactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function validateResult(result, label = 'result') {
  assert(hasExactKeys(result, RESULT_FIELDS), `${label} must contain exactly ${RESULT_FIELDS.join(', ')}`);
  assert(isText(result.title), `${label}.title must be nonempty text`);
  assert(isText(result.claim), `${label}.claim must be nonempty text`);
  assert(isStringArray(result.evidence), `${label}.evidence must be a string array`);
  assert(isStringArray(result.uncertainties), `${label}.uncertainties must be a string array`);
  assert(isText(result.verification), `${label}.verification must be nonempty text`);
  return {
    title: result.title,
    claim: result.claim,
    evidence: [...result.evidence],
    uncertainties: [...result.uncertainties],
    verification: result.verification,
  };
}

function validateDispatchId(dispatchId) {
  assert(typeof dispatchId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(dispatchId), 'dispatchId must be a safe nonempty identifier');
  return dispatchId;
}

export function parseMemberResult(text, expectedDispatchId) {
  assert(typeof text === 'string' && text.trim().length > 0, 'member result must be nonempty JSON text');
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`member result is not JSON: ${error.message}`); }
  assert(hasExactKeys(parsed, ['dispatchId', 'results']), 'member result must contain exactly dispatchId and results');
  validateDispatchId(parsed.dispatchId);
  assert(parsed.dispatchId === expectedDispatchId, `member result dispatchId mismatch: expected ${expectedDispatchId}`);
  assert(Array.isArray(parsed.results) && parsed.results.length >= 1 && parsed.results.length <= 32, 'member result results must contain 1-32 items');
  return {
    dispatchId: parsed.dispatchId,
    results: parsed.results.map((result, index) => validateResult(result, `results[${index}]`)),
  };
}

function validateCombinedResult(result, index) {
  const combinedKeys = ['resultNo', 'sourceDispatchId', ...RESULT_FIELDS];
  assert(hasExactKeys(result, combinedKeys), `combined result ${index} has invalid fields`);
  assert(Number.isSafeInteger(result.resultNo) && result.resultNo >= 1, `combined result ${index} has invalid resultNo`);
  validateDispatchId(result.sourceDispatchId);
  const { resultNo, sourceDispatchId, ...payload } = result;
  return { resultNo, sourceDispatchId, ...validateResult(payload, `combined result ${index}`) };
}

export function combineResults(memberResults) {
  assert(Array.isArray(memberResults) && memberResults.length >= 1, 'at least one member result is required');
  const normalized = memberResults.map((member, index) => {
    assert(isObject(member), `member result ${index} must be an object`);
    validateDispatchId(member.dispatchId);
    return parseMemberResult(JSON.stringify(member), member.dispatchId);
  });
  const dispatchIds = normalized.map(member => member.dispatchId);
  assert(new Set(dispatchIds).size === dispatchIds.length, 'duplicate member dispatchId');
  normalized.sort((left, right) => left.dispatchId < right.dispatchId ? -1 : left.dispatchId > right.dispatchId ? 1 : 0);
  let resultNo = 1;
  return normalized.flatMap(member => member.results.map(result => ({
    resultNo: resultNo++,
    sourceDispatchId: member.dispatchId,
    ...result,
  })));
}

export function validateCombinedResults(results, dispatchIds) {
  assert(Array.isArray(results) && results.length >= 1, 'combined result JSON must be a nonempty array');
  const normalized = results.map(validateCombinedResult);
  const counts = new Map();
  normalized.forEach((result, index) => {
    assert(result.resultNo === index + 1, 'combined resultNo values must be contiguous from 1');
    assert(index === 0 || normalized[index - 1].sourceDispatchId <= result.sourceDispatchId, 'combined authors must be in ASCII order');
    counts.set(result.sourceDispatchId, (counts.get(result.sourceDispatchId) ?? 0) + 1);
  });
  assert([...counts.values()].every(count => count <= 32), 'combined author results must contain 1-32 items');
  if (dispatchIds !== undefined) {
    const members = normalizeDispatchIds(dispatchIds);
    assert(counts.size === members.length && members.every(id => counts.has(id)), 'combined authors must match manifest dispatchIds exactly');
  }
  return normalized;
}

export function parseCombinedJson(text, dispatchIds) {
  assert(typeof text === 'string', 'combined JSON must be text');
  return validateCombinedResults(JSON.parse(text), dispatchIds);
}

export function renderCombinedResults(results) {
  const normalized = validateCombinedResults(results);
  return `# Combined Results\n\n${COMBINE_BEGIN}\n${JSON.stringify(normalized, null, 2)}\n${COMBINE_END}\n`;
}

export function parseCombinedResults(text) {
  assert(typeof text === 'string', 'combined result must be text');
  const begin = text.indexOf(COMBINE_BEGIN);
  const end = text.indexOf(COMBINE_END);
  assert(begin >= 0 && end > begin, 'combined result JSON markers are missing or out of order');
  assert(text.indexOf(COMBINE_BEGIN, begin + COMBINE_BEGIN.length) === -1, 'combined result has duplicate begin marker');
  assert(text.indexOf(COMBINE_END, end + COMBINE_END.length) === -1, 'combined result has duplicate end marker');
  const source = text.slice(begin + COMBINE_BEGIN.length, end).trim();
  let parsed;
  try { parsed = JSON.parse(source); } catch (error) { throw new Error(`combined result JSON is invalid: ${error.message}`); }
  return validateCombinedResults(parsed);
}

export function parseVoteCsv(text, resultNos) {
  assert(typeof text === 'string', 'vote CSV must be text');
  assert(Array.isArray(resultNos) && resultNos.length >= 1, 'vote CSV needs expected result numbers');
  assert(resultNos.every(no => Number.isSafeInteger(no) && no > 0) && new Set(resultNos).size === resultNos.length, 'expected result numbers must be unique positive safe integers');
  const expected = [...resultNos].sort((left, right) => left - right);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert(lines.length === expected.length, `vote CSV must contain exactly ${expected.length} rows`);
  const votes = lines.map((line, index) => {
    assert(line.trim().length > 0, `vote CSV row ${index + 1} is empty`);
    const fields = line.split(',');
    assert(fields.length === 2, `vote CSV row ${index + 1} must contain exactly two columns`);
    assert(fields[0].trim() !== 'resultNo' && fields[1].trim() !== 'score', 'vote CSV must not contain a header');
    assert(/^[1-9][0-9]*$/.test(fields[0]), `vote CSV row ${index + 1} has invalid resultNo`);
    assert(/^[0-5]$/.test(fields[1]), `vote CSV row ${index + 1} has invalid score`);
    const resultNo = Number(fields[0]);
    const score = Number(fields[1]);
    assert(Number.isSafeInteger(resultNo) && resultNo >= 1, `vote CSV row ${index + 1} has invalid resultNo`);
    assert(Number.isInteger(score) && score >= 0 && score <= 5, `vote CSV row ${index + 1} has invalid score`);
    return { resultNo, score };
  });
  const numbers = votes.map(vote => vote.resultNo).sort((left, right) => left - right);
  assert(numbers.length === expected.length && numbers.every((number, index) => number === expected[index]), 'vote CSV resultNo values must match the combine board exactly');
  return votes;
}

function normalizeDispatchIds(dispatchIds) {
  assert(Array.isArray(dispatchIds) && dispatchIds.length >= 1, 'dispatchIds must be a nonempty array');
  dispatchIds.forEach(validateDispatchId);
  assert(new Set(dispatchIds).size === dispatchIds.length, 'dispatchIds must be unique');
  return [...dispatchIds];
}

export function calculateScores({ results, dispatchIds, votesByDispatch, failures = [], threshold = DEFAULT_THRESHOLD, maxSpread = DEFAULT_MAX_SPREAD }) {
  const members = normalizeDispatchIds(dispatchIds);
  const normalizedResults = validateCombinedResults(results, members);
  assert(Array.isArray(failures), 'failures must be an array');
  assert(Number.isFinite(threshold), 'threshold must be finite');
  assert(Number.isFinite(maxSpread) && maxSpread >= 0, 'maxSpread must be nonnegative');
  const resultNos = normalizedResults.map(result => result.resultNo);
  const voteFiles = isObject(votesByDispatch) ? votesByDispatch : Object.fromEntries(votesByDispatch ?? []);
  assert(Object.keys(voteFiles).every(id => members.includes(id)), 'unknown vote dispatchId');
  const parsedVotes = new Map();
  const voteStatuses = [];
  for (const dispatchId of members) {
    const source = Object.hasOwn(voteFiles, dispatchId) ? voteFiles[dispatchId] : undefined;
    if (typeof source !== 'string') {
      voteStatuses.push({ dispatchId, status: 'missing', error: 'vote CSV is missing' });
      continue;
    }
    try {
      parsedVotes.set(dispatchId, parseVoteCsv(source, resultNos));
      voteStatuses.push({ dispatchId, status: 'ok' });
    } catch (error) {
      voteStatuses.push({ dispatchId, status: 'invalid', error: error.message });
    }
  }
  const requiredVotes = Math.max(3, Math.ceil(0.75 * (members.length - 1)));
  const scoredResults = normalizedResults.map(result => {
    const scores = [];
    for (const dispatchId of members) {
      if (dispatchId === result.sourceDispatchId) continue;
      const vote = parsedVotes.get(dispatchId)?.find(candidate => candidate.resultNo === result.resultNo);
      if (vote) scores.push({ dispatchId, score: vote.score });
    }
    const values = scores.map(vote => vote.score);
    const validVotes = values.length;
    const mean = validVotes ? values.reduce((sum, value) => sum + value, 0) / validVotes : null;
    const min = validVotes ? Math.min(...values) : null;
    const max = validVotes ? Math.max(...values) : null;
    const spread = validVotes ? max - min : null;
    const qualifies = validVotes >= requiredVotes && mean !== null && mean > threshold;
    let status;
    if (validVotes < requiredVotes) status = 'insufficient_votes';
    else if (!qualifies) status = 'below_threshold';
    else if (spread >= maxSpread || voteStatuses.some(vote => vote.status !== 'ok') || failures.length > 0) status = 'needs_review';
    else status = 'candidate';
    return {
      resultNo: result.resultNo,
      sourceDispatchId: result.sourceDispatchId,
      title: result.title,
      claim: result.claim,
      evidence: result.evidence,
      uncertainties: result.uncertainties,
      verification: result.verification,
      scores,
      validVotes,
      requiredVotes,
      mean,
      min,
      max,
      spread,
      qualifies,
      status,
    };
  });
  return { protocolVersion: PROTOCOL_VERSION, requiredVotes, threshold, maxSpread, failures, voteStatuses, results: scoredResults };
}

export function renderFinalResult(result) {
  assert(isObject(result), 'final result must be an object');
  return `# Final Collective Deliberation Result\n\n${JSON.stringify(result, null, 2)}\n`;
}

function safeRunPath(runDir, candidate) {
  const root = resolve(runDir);
  const path = resolve(root, candidate);
  const rel = relative(root, path);
  assert(rel === '' || !rel.startsWith('..'), `path escapes run directory: ${candidate}`);
  return path;
}

function validatePhase(phase, maxRetries, label) {
  assert(isObject(phase) && ['ok', 'failed'].includes(phase.status), `${label} must have a terminal status`);
  assert(Array.isArray(phase.attempts) && phase.attempts.length >= 1 && phase.attempts.length <= maxRetries + 1, `${label} has invalid attempt count`);
  phase.attempts.forEach((attempt, index) => {
    assert(isObject(attempt) && ['ok', 'failed'].includes(attempt.status), `${label} attempt must be terminal`);
    assert(isText(attempt.startedAt) && isText(attempt.endedAt) && Number.isFinite(Date.parse(attempt.startedAt)) && Date.parse(attempt.endedAt) >= Date.parse(attempt.startedAt), `${label} attempt timestamps are invalid`);
    assert(attempt.status !== 'failed' || isText(attempt.error), `${label} failed attempt needs error`);
    assert(index === phase.attempts.length - 1 || attempt.status === 'failed', `${label} retry must follow failure`);
  });
  assert(phase.attempts.at(-1).status === phase.status, `${label} status must match last attempt`);
  assert(phase.status !== 'failed' || phase.attempts.length === maxRetries + 1, `${label} failed before retry budget exhausted`);
}

async function loadManifest(runDir) {
  const path = safeRunPath(runDir, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); } catch (error) { throw new Error(`cannot read manifest.json: ${error.message}`); }
  assert(isObject(manifest), 'manifest must be an object');
  for (const key of ['runId', 'dispatchIds', 'resultFiles', 'voteFiles']) assert(Object.hasOwn(manifest, key), `manifest missing ${key}`);
  assert(typeof manifest.runId === 'string' && manifest.runId.length > 0, 'manifest.runId must be nonempty');
  const dispatchIds = normalizeDispatchIds(manifest.dispatchIds);
  assert(isText(manifest.topicVersion), 'manifest.topicVersion must be nonempty');
  assert(isObject(manifest.permissionStatus), 'manifest.permissionStatus must be an object');
  assert(Number.isSafeInteger(manifest.maxRetryAttempts) && manifest.maxRetryAttempts >= 0, 'manifest.maxRetryAttempts must be a nonnegative integer');
  assert(Array.isArray(manifest.failures) && manifest.failures.every(failure => isObject(failure) && isText(failure.error)), 'manifest.failures must contain error records');
  assert(Array.isArray(manifest.members) && manifest.members.length === dispatchIds.length, 'manifest.members must cover dispatchIds');
  assert(new Set(manifest.members.map(member => member.dispatchId)).size === dispatchIds.length, 'manifest.members dispatchIds must be unique');
  assert(new Set(manifest.members.map(member => member.sessionId)).size === dispatchIds.length, 'manifest.members sessionIds must be unique');
  for (const member of manifest.members) {
    assert(dispatchIds.includes(member.dispatchId) && isText(member.sessionId) && isText(member.environmentId), 'member needs dispatchId, sessionId and environmentId');
    validatePhase(member.proposal, manifest.maxRetryAttempts, `${member.dispatchId}.proposal`);
  }
  assert(isObject(manifest.resultFiles) && isObject(manifest.voteFiles), 'manifest resultFiles/voteFiles must be objects');
  for (const key of ['resultFiles', 'voteFiles']) {
    assert(Object.keys(manifest[key]).length === dispatchIds.length, `manifest.${key} must match dispatchIds`);
  }
  for (const dispatchId of dispatchIds) {
    assert(manifest.resultFiles[dispatchId] === `tmp-result-${dispatchId}.json`, `manifest has invalid result file for ${dispatchId}`);
    assert(manifest.voteFiles[dispatchId] === `vote-${dispatchId}.csv`, `manifest has invalid vote file for ${dispatchId}`);
  }
  return { ...manifest, dispatchIds };
}

async function loadProposals(runDir, manifest) {
  assert(manifest.members.every(member => member.proposal.status === 'ok'), 'proposal barrier requires all members ok');
  const memberResults = [];
  for (const dispatchId of manifest.dispatchIds) {
    const path = safeRunPath(runDir, manifest.resultFiles[dispatchId]);
    const content = await readFile(path, 'utf8');
    memberResults.push(parseMemberResult(content, dispatchId));
  }
  return combineResults(memberResults);
}

async function combineCommand(runDir) {
  const manifest = await loadManifest(runDir);
  const results = await loadProposals(runDir, manifest);
  const path = safeRunPath(runDir, 'tmp-result-combine.json');
  const jsonText = `${JSON.stringify(results, null, 2)}\n`;
  const markdown = renderCombinedResults(results);
  await writeFile(path, jsonText, 'utf8');
  await writeFile(safeRunPath(runDir, 'tmp-result-combine.md'), markdown, 'utf8');
  return { protocolVersion: PROTOCOL_VERSION, runId: manifest.runId, resultCount: results.length, jsonPath: path, markdownPath: safeRunPath(runDir, 'tmp-result-combine.md'), jsonSha256: createHash('sha256').update(jsonText).digest('hex'), markdownSha256: createHash('sha256').update(markdown).digest('hex') };
}

async function scoreCommand(runDir) {
  const manifest = await loadManifest(runDir);
  for (const member of manifest.members) validatePhase(member.vote, manifest.maxRetryAttempts, `${member.dispatchId}.vote`);
  const combinePath = safeRunPath(runDir, 'tmp-result-combine.json');
  const combined = parseCombinedJson(await readFile(combinePath, 'utf8'), manifest.dispatchIds);
  assert(JSON.stringify(combined) === JSON.stringify(await loadProposals(runDir, manifest)), 'canonical JSON differs from original member results');
  assert(await readFile(safeRunPath(runDir, 'tmp-result-combine.md'), 'utf8') === renderCombinedResults(combined), 'combined Markdown differs from canonical JSON');
  const votes = Object.create(null);
  const failures = [...manifest.failures];
  const files = [];
  const inputNames = ['manifest.json', ...Object.values(manifest.resultFiles), 'tmp-result-combine.json', 'tmp-result-combine.md', ...Object.values(manifest.voteFiles)];
  for (const name of inputNames) {
    const path = safeRunPath(runDir, name);
    try {
      const bytes = await readFile(path);
      files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, status: 'ok' });
      const dispatchId = manifest.dispatchIds.find(id => manifest.voteFiles[id] === name);
      if (dispatchId && manifest.members.find(member => member.dispatchId === dispatchId).vote.status === 'ok') votes[dispatchId] = bytes.toString('utf8');
    } catch (error) {
      if (!Object.values(manifest.voteFiles).includes(name)) throw error;
      const failure = { phase: 'vote', path, code: error.code ?? 'READ_ERROR', error: error.message };
      failures.push(failure);
      files.push({ path, status: 'unreadable', ...failure });
    }
  }
  for (const member of manifest.members) {
    for (const phase of ['proposal', 'vote']) {
      member[phase].attempts.forEach((attempt, index) => {
        if (attempt.status === 'failed') failures.push({ dispatchId: member.dispatchId, phase, attempt: index + 1, ...attempt });
      });
    }
  }
  const scored = calculateScores({ results: combined, dispatchIds: manifest.dispatchIds, votesByDispatch: votes, failures, threshold: manifest.threshold ?? DEFAULT_THRESHOLD, maxSpread: manifest.maxSpread ?? DEFAULT_MAX_SPREAD });
  for (const vote of scored.voteStatuses) {
    const phase = manifest.members.find(member => member.dispatchId === vote.dispatchId).vote;
    if (phase.status === 'failed') {
      vote.status = 'failed';
      vote.error = phase.attempts.at(-1).error;
    }
    vote.path = safeRunPath(runDir, manifest.voteFiles[vote.dispatchId]);
    if (vote.status !== 'ok') failures.push({ dispatchId: vote.dispatchId, phase: 'vote', path: vote.path, error: vote.error });
  }
  const jsonPath = safeRunPath(runDir, 'final-result.json');
  const mdPath = safeRunPath(runDir, 'final-result.md');
  const counts = Object.fromEntries(['candidate', 'needs_review', 'below_threshold', 'insufficient_votes'].map(status => [status, scored.results.filter(result => result.status === status).length]));
  const final = {
    ...scored,
    runId: manifest.runId,
    topicVersion: manifest.topicVersion,
    audit: manifest,
    files,
    outputFiles: { jsonPath, mdPath },
    combineFile: combinePath,
    dispatchIds: manifest.dispatchIds,
    resultCount: scored.results.length,
    counts,
  };
  await writeFile(jsonPath, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderFinalResult(final), 'utf8');
  return { ...final, jsonPath, mdPath };
}

async function main() {
  const [command, runDir] = process.argv.slice(2);
  if (!['combine', 'score'].includes(command) || !runDir || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/council.mjs combine <run-dir> | score <run-dir>');
  }
  const result = command === 'combine' ? await combineCommand(runDir) : await scoreCommand(runDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
