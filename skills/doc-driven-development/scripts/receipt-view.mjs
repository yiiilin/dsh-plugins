// Read-only projections of captured execution. Never create or edit a receipt.
import fs from 'node:fs';
import { safePath, sha } from './lib.mjs';
import { checkRun } from './verification.mjs';

export function parseReceiptRef(value) {
  const m = typeof value === 'string' && value.match(/^(.+\/run\.json)#([a-f0-9]{64})$/);
  if (!m) throw new Error('Expected a pinned runner receipt: path/to/run.json#64-lowercase-hex');
  return { path: m[1], hash: m[2] };
}

// Summaries are views, not another editable source of verification facts. The one-line
// pointer can be stored in a document HEADER (bookkeeping, outside contract content).
export function receiptSummary(root, config, rel, { plan } = {}) {
  const checked = checkRun(root, config, rel, { plan });
  let pointer = null;
  if (!checked.errors.length) {
    // checkRun validated the file and its captured outputs; re-read for a pinned link.
    const hash = sha(fs.readFileSync(safePath(root, rel)));
    const again = checkRun(root, config, rel, { plan, hash });
    if (again.errors.length) return { ...again, text: format(again, rel, null), pointer: null };
    pointer = `${rel}#${hash}`;
    return { ...again, pointer, text: format(again, rel, pointer) };
  }
  return { ...checked, pointer, text: format(checked, rel, pointer) };
}
const plain = value => String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').replace(/([\[\]\*\`\|<>])/g, '\\$1');
function format(checked, rel, pointer) {
  const r = checked.report, lines = [];
  lines.push(`验证：${plain(r?.name ?? '运行记录')}`);
  lines.push(checked.errors.length ? '当前结论：不能认定已验证。' : '当前结论：所列检查实际通过；完整业务交付仍需核对要求及验证层。');
  if (r) {
    lines.push(`环境：${plain(r.environment?.name)}。`);
    for (const c of Array.isArray(r.results) ? r.results : []) {
      if (!c || typeof c !== 'object') continue;
      const planned = checked.plan?.checks?.find(p => p.id === c.id);
      const state = c.status === 'passed' ? (checked.errors.length ? '当时执行通过，当前有效性未通过核对' : '实际执行通过') : c.status;
      const labels = { static: '静态检查', component: '组件', integration: '集成', acceptance: '场景验收', regression: '回归' };
      const levels = [c.level, ...(Array.isArray(c.alsoLevels) ? c.alsoLevels : [])].map(l => labels[l] ?? plain(l)).join(' / ');
      lines.push(`${plain(c.name)}（${levels}）：${state}。${plain(planned?.scenario ?? c.reason)}`);
      const optional = Array.isArray(c.cases) ? c.cases.filter(x => x && ['skipped', 'todo'].includes(x.status)) : [];
      if (optional.length) lines.push(`跳过/待办：${optional.map(x => plain(x.name)).join('、')}；不得替代必测。`);
    }
    const limits = checked.plan?.environment?.limitations ?? r.environment?.limitations;
    if (limits) lines.push(`范围限制：${plain(limits)}`);
  }
  for (const e of checked.errors) lines.push(`未通过核对：${plain(e)}`);
  lines.push(`详细运行记录：${plain(rel)}`);
  if (pointer) lines.push('', '仅将下面一行放入对应规格的文档头；不必复制结果字段或重复创建 E 记录：', `Verification-Receipt: ${pointer}`);
  lines.push('本地未签名记录只检测变化，不是防恶意篡改证明；真实批准、断言充分性及外部环境仍需核对。');
  return lines.join('\n');
}
