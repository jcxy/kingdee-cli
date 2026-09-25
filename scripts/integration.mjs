/**
 * kd CLI 真实环境集成测试（校准产物，序列已在真实环境逐项验证）。
 *
 * 用法：npm run test:integration [-- --rule <转换规则内码>]
 * 前置：
 *   - ~/.kingdee-cli/config.yaml 的 default-profile 指向可写环境
 *   - 环境变量 KD_TRACE_FIELD=<站点追踪字段 key>（delete-chain 反查与 save 标记用；
 *     未设置时跳过写路径用例，仅跑只读用例）
 *   - 可选：KD_TEST_CUSTOMER / KD_TEST_MATERIAL 覆盖测试单据的客户/物料编码
 *     （默认 CU-IT-001 / M-IT-001，站点需存在这两个基础资料或显式覆盖）
 * 行为：所有新增单据带追踪标记 IT-<时间戳>，测试结束自动清理；
 *       中途失败时按标记用 kd delete-chain 手工清理。
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const KD_CLI = join(
  homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
  '@cvtoolman', 'kingdee-cli', 'dist', 'cli.js',
);

const ruleArg = process.argv.includes('--rule') ? process.argv[process.argv.indexOf('--rule') + 1] : undefined;
const TRACE_FIELD = process.env.KD_TRACE_FIELD;
const CUSTOMER = process.env.KD_TEST_CUSTOMER || 'CU-IT-001';
const MATERIAL = process.env.KD_TEST_MATERIAL || 'M-IT-001';
const BILLNO_PREFIX = process.env.KD_TEST_BILLNO_PREFIX || 'SO';

let passed = 0;
let failed = 0;
const cleanupIds = [];

function kd(args) {
  const r = spawnSync(process.execPath, [KD_CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{"ok"'));
  return line
    ? JSON.parse(line)
    : { ok: false, raw: ((r.stdout || '') + (r.stderr || '')).slice(0, 400) };
}

function step(name, args, check) {
  const r = kd(args);
  const ok = r.ok && (!check || check(r) !== false);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}: ${JSON.stringify(r.error ?? r).slice(0, 300)}`); }
  return r;
}

function cleanup() {
  for (const { id, tag } of cleanupIds) {
    kd(['delete-chain', '--trace-id', tag, '--trace-field', TRACE_FIELD, '--yes']);
    kd(['delete', '--form', 'sales-order', '--ids', id, '--yes']);
  }
}

try {
  console.log('== 1. 配置与别名（只读）');
  step('config test', ['config', 'test'], (r) => r.data?.auth === 'app');
  step('config list', ['config', 'list']);
  step('aliases', ['aliases'], (r) => Array.isArray(r.data) && r.data.length >= 13);

  console.log('== 2. 查询原语（只读）');
  step('metadata sales-order', ['metadata', '--form', 'sales-order']);
  step('query-json inventory', ['query-json', '--form', 'inventory', '--fields', 'FMaterialId.FNumber,FQty', '--limit', '5']);
  step('query-json 枚举字段(无 .FName)', ['query-json', '--form', 'sales-order', '--fields', 'FBillNo,FDocumentStatus', '--limit', '3']);
  step('count 字符串 filter', ['count', '--form', 'sales-order', '--filter', `FBillNo like '${BILLNO_PREFIX}%'`]);
  step('count 数字 filter', ['count', '--form', 'sales-order', '--filter', 'FID=1'], (r) => r.data?.count === 0);

  console.log('== 3. 大数据量命令（只读）');
  step('query-all', ['query-all', '--form', 'sales-order', '--fields', 'FBillNo,FDate', '--filter', `FBillNo like '${BILLNO_PREFIX}%'`, '--max', '50']);
  step('query-range day 分片', ['query-range', '--form', 'sales-order', '--fields', 'FBillNo', '--from', '2026-09-01', '--to', '2026-09-25', '--date-field', 'FDate', '--granularity', 'day', '--max', '5000']);

  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '.scratch', 'it-out.ndjson');
  step('query-file ndjson', ['query-file', '--form', 'sales-order', '--fields', 'FBillNo', '--filter', `FBillNo like '${BILLNO_PREFIX}%'`, '--out', out, '--format', 'ndjson', '--max', '100']);
  try { rmSync(out); } catch { /* 忽略 */ }

  if (!TRACE_FIELD) {
    console.log('== 4. 写路径：跳过（未设置 KD_TRACE_FIELD，无法构造可反查的追踪标记）');
  } else {
    console.log('== 4. 写路径全生命周期');
    const TAG = 'IT-' + Date.now();
    const model = JSON.stringify({
      Model: {
        FDate: new Date().toISOString().slice(0, 10),
        FCustId: { FNumber: CUSTOMER },
        [TRACE_FIELD]: TAG,
        FSaleOrderEntry: [{ FMaterialId: { FNumber: MATERIAL }, FQty: 2 }],
      },
    });

    const saved = step('save 创建（带追踪标记）', ['save', '--form', 'sales-order', '--data', model]);
    if (!saved.ok) throw new Error('save 失败，无法继续生命周期');
    const id = String(saved.data.Id);
    cleanupIds.push({ id, tag: TAG });

    step('count 追踪字段反查=1', ['count', '--form', 'sales-order', '--filter', `${TRACE_FIELD}='${TAG}'`], (r) => r.data?.count === 1);
    step('view --id', ['view', '--form', 'sales-order', '--id', id]);
    step('submit', ['submit', '--form', 'sales-order', '--ids', id]);
    step('audit', ['audit', '--form', 'sales-order', '--ids', id]);

    if (ruleArg) {
      step('push（--rule 指定规则）', ['push', '--form', 'sales-order', '--ids', id, '--target-form', 'sal-outstock', '--rule', ruleArg]);
      step('出库单追踪字段反查', ['count', '--form', 'sal-outstock', '--filter', `${TRACE_FIELD}='${TAG}'`]);
    } else {
      console.log('  - 跳过 push（站点无默认转换规则；用 --rule <内码> 启用）');
    }

    const dry = step('delete-chain dry-run', ['delete-chain', '--trace-id', TAG, '--trace-field', TRACE_FIELD]);
    step('delete-chain --yes 全链清理', ['delete-chain', '--trace-id', TAG, '--trace-field', TRACE_FIELD, '--yes']);
    step('清理确认 count=0', ['count', '--form', 'sales-order', '--filter', `FID=${id}`], (r) => r.data?.count === 0);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  cleanup();
}
