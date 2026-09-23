// Bounded process execution; NOT a security sandbox. No shell is added implicitly.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertNode, safePath, sha } from './lib.mjs';

export const SYSTEM_ENV = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
export function restrictedEnv(names = [], injected = {}) {
  const env = {};
  for (const key of [...SYSTEM_ENV, ...names]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...injected };
}
export function redact(text, names = []) {
  let value = String(text);
  // Full-buffer redaction also catches values split across output chunks. Not a DLP system.
  for (const secret of [...new Set(names.map(n => process.env[n]).filter(Boolean))].sort((a,b) => b.length-a.length))
    { value = value.split(secret).join('[REDACTED]');
      const escaped=JSON.stringify(secret).slice(1,-1);
      if(escaped!==secret)value=value.split(escaped).join('[REDACTED]'); }
  return value;
}
export function executable(root, value) {
  if (value === 'node') return process.execPath;
  if (value.includes('/') || value.includes('\\')) return safePath(root, value);
  if (!/^[A-Za-z0-9_.+-]+$/.test(value)) throw new Error('Executable must be a simple PATH name or repository-relative file.');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
    for (const ext of extensions) {
      const file = path.join(dir, value + ext);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch { /* next candidate */ }
    }
  }
  throw new Error(`Executable not available: ${value}`);
}
export function fileHash(file, max = 64 * 1024 * 1024) {
  const s = fs.statSync(file);
  if (!s.isFile() || s.size > max) throw new Error('Expected a bounded regular file for hashing.');
  return sha(fs.readFileSync(file));
}
export async function execute({ command, args = [], cwd, env, timeoutMs = 60000, maxOutputBytes = 4 * 1024 * 1024, input = null }) {
  const startedAt = new Date().toISOString(), start = performance.now();
  return new Promise(resolve => {
    let child, reason = null, error = null, bytes = 0, finished = false, timer, escalation;
    const out = [], err = [];
    const terminate = why => {
      reason ??= why;
      if (!child?.pid) return;
      const kill = sig => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch { /* already exited */ } };
      kill('SIGTERM');
      escalation ??= setTimeout(() => { kill('SIGKILL'); child.stdout?.destroy(); child.stderr?.destroy(); }, 300);
    };
    const onInt = () => terminate('interrupted'), onTerm = () => terminate('interrupted');
    const finish = (exitCode, signal) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(escalation);
      process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
      // Do not leave ordinary background children in the process group after a check.
      if (process.platform !== 'win32' && child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* absent */ } }
      resolve({ startedAt, endedAt: new Date().toISOString(), durationMs: Math.round(performance.now()-start),
        exitCode, signal, reason, error, outputBytes: bytes, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    const capture = target => chunk => {
      const b = Buffer.from(chunk), remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining) target.push(b.subarray(0, remaining));
      bytes += b.length;
      if (bytes > maxOutputBytes) terminate('output-limit');
    };
    try {
      child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      child.stdout.on('data', capture(out)); child.stderr.on('data', capture(err));
      child.stdin.on('error', () => {}); child.stdin.end(input ?? undefined);
      child.on('error', e => { error = e.code ?? e.message; });
      child.on('close', finish);
      process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
      timer = setTimeout(() => terminate('timeout'), timeoutMs);
    } catch (e) { error = e.code ?? e.message; finish(null, null); }
  });
}
export async function runAsyncCLI(main) {
  try { assertNode(); await main(); }
  catch (e) { console.error(`ERROR ${e.message}`); process.exitCode = 2; }
}
