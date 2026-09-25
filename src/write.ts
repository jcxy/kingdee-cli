import { resolveFormArg } from './read.js';
import { EXIT_CODES } from './exit-codes.js';
import {
  DYNAMIC_FORM_SERVICE,
  assertBusinessSuccess,
  callService,
  extractBusinessResult,
  KdsvcError,
} from './kdsvc.js';
import type { Profile } from './config.js';
import { createInterface } from 'node:readline/promises';

/** --max-count 默认值（spec Implementation Decisions：批量上限默认 50） */
export const DEFAULT_MAX_COUNT = 50;

export interface BillRef {
  /** 单据内码（FID）；直接传 --numbers 时为空串 */
  id: string;
  /** 单据编号；直接传 --ids 时为 null */
  number: string | null;
}

/** 目标单据集合 + 发给金蝶的定位载荷（Ids 或 Numbers 二选一） */
export interface Selection {
  formId: string;
  refs: BillRef[];
  pk: { Ids?: string; Numbers?: string[] };
}

export interface SelectionOptions {
  ids?: string;
  numbers?: string;
  filter?: string;
  maxCount: number;
}

/** 写操作闸门：readonly 模式（profile 级或 --mode）物理拒绝，exit 6 */
export function assertWriteAllowed(profile: Profile): void {
  if ((profile.mode ?? 'readwrite') === 'readonly') {
    throw new KdsvcError(
      EXIT_CODES.READONLY_DENIED,
      '当前为 readonly 模式，写操作已被拒绝',
      [
        '改用 readwrite 的 profile 执行写操作',
        '或临时加 --mode readwrite 覆盖（请确认操作对象与影响面）',
      ],
    );
  }
}

export function parseMaxCount(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX_COUNT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-count 必须是正整数，收到: ${raw}`);
  }
  return n;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析目标单据集合：--ids / --numbers / --filter 三选一。
 * --filter 先走 ExecuteBillQuery 解析影响面（Limit = maxCount+1 用于熔断检测）；
 * 超过 maxCount 熔断 exit 7；未命中任何单据报参数错误。
 */
export async function resolveSelection(
  profile: Profile,
  form: string,
  o: SelectionOptions,
): Promise<Selection> {
  const formId = resolveFormArg(form).formId;
  const ids = splitList(o.ids);
  const numbers = splitList(o.numbers);

  // 契约强制三选一：静默按优先级取舍会让调用方误以为全部目标都生效
  const provided = (ids.length ? 1 : 0) + (numbers.length ? 1 : 0) + (o.filter ? 1 : 0);
  if (provided > 1) {
    throw new Error('--ids / --numbers / --filter 只能三选一，请勿同时传入');
  }

  let refs: BillRef[];
  let pk: Selection['pk'];
  if (ids.length) {
    refs = ids.map((id) => ({ id, number: null }));
    pk = { Ids: ids.join(',') };
  } else if (numbers.length) {
    refs = numbers.map((no) => ({ id: '', number: no }));
    pk = { Numbers: numbers };
  } else if (o.filter) {
    const raw = await callService(profile, DYNAMIC_FORM_SERVICE.executeBillQuery, [
      {
        FormId: formId,
        FieldKeys: 'FID,FBillNo',
        FilterString: o.filter,
        Limit: o.maxCount + 1,
        StartRow: 0,
      },
    ]);
    assertBusinessSuccess(raw, '影响面解析');
    if (!Array.isArray(raw) || !raw.every((row) => Array.isArray(row))) {
      throw new Error('金蝶查询响应不符合协议（期望二维数组）');
    }
    refs = (raw as unknown[][]).map((row) => ({
      id: row[0] == null ? '' : String(row[0]),
      number: row[1] == null ? null : String(row[1]),
    }));
    pk = { Ids: refs.map((r) => r.id).join(',') };
  } else {
    throw new Error('需要 --ids / --numbers / --filter 之一来选择目标单据');
  }

  if (refs.length > o.maxCount) {
    throw new KdsvcError(
      EXIT_CODES.MAX_COUNT_REACHED,
      `本次操作影响 ${refs.length} 张单据，超过批量上限 ${o.maxCount}`,
      [
        '调整 --filter 缩小影响范围',
        '或用 --max-count 显式提高上限（确认你知道自己在批量操作什么）',
      ],
    );
  }
  if (refs.length === 0) {
    throw new Error('未命中任何单据，请检查 --ids / --numbers / --filter');
  }

  return { formId, refs, pk };
}

/**
 * 危险命令（unaudit/delete）的执行闸门：
 * --yes 直接执行；TTY 下交互确认（stderr 提问，不污染 stdout JSON）；
 * 非 TTY（agent/脚本）未带 --yes 一律不执行，返回影响面明细走 dry-run 输出。
 */
export async function confirmOrDryRun(
  refs: BillRef[],
  opts: { yes?: boolean; action: string },
): Promise<{ executed: boolean }> {
  if (opts.yes === true) return { executed: true };
  if (process.stdin.isTTY) {
    // 确认前先展示影响面明细（stderr），--filter 误匹配时人工能看见具体单据
    const preview = refs
      .slice(0, 20)
      .map((r) => `  - ${r.number ?? `(FID)${r.id}`}`)
      .join('\n');
    process.stderr.write(
      `受影响单据（${refs.length} 张）：\n${preview}${refs.length > 20 ? `\n  ...等 ${refs.length} 张` : ''}\n`,
    );
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (
      await rl.question(`即将${opts.action} ${refs.length} 张单据，确认执行? (y/N) `)
    )
      .trim()
      .toLowerCase();
    rl.close();
    return { executed: answer === 'y' || answer === 'yes' };
  }
  return { executed: false };
}

/** Save：新增单据，data 为单据 JSON 字符串 */
export async function executeSave(
  profile: Profile,
  form: string,
  dataJson: string,
): Promise<unknown> {
  const formId = resolveFormArg(form).formId;
  const raw = await callService(profile, DYNAMIC_FORM_SERVICE.save, [formId, dataJson]);
  return extractBusinessResult(raw, '保存');
}

/** Submit/Audit/UnAudit/Delete：[formId, pkJSON]；cookie 可选（复合命令复用会话） */
export async function executePkOperation(
  profile: Profile,
  service: string,
  sel: Selection,
  context: string,
  cookie?: string,
): Promise<unknown> {
  const raw = await callService(profile, service, [sel.formId, JSON.stringify(sel.pk)], cookie);
  return extractBusinessResult(raw, context);
}

/** ExecuteOperation：自定义操作（禁用/反禁用等），[formId, opNumber, pkJSON] */
export async function executeCustomOperation(
  profile: Profile,
  form: string,
  opNumber: string,
  sel: Selection,
): Promise<unknown> {
  const formId = resolveFormArg(form).formId;
  const raw = await callService(profile, DYNAMIC_FORM_SERVICE.executeOperation, [
    formId,
    opNumber,
    JSON.stringify(sel.pk),
  ]);
  return extractBusinessResult(raw, `自定义操作 ${opNumber}`);
}

/** Push：下推，[formId, {Ids|Numbers, TargetFormId, TargetOrgId, RuleId?}] */
export async function executePush(
  profile: Profile,
  form: string,
  sel: Selection,
  targetForm: string,
  ruleId?: string,
): Promise<unknown> {
  const formId = resolveFormArg(form).formId;
  const targetFormId = resolveFormArg(targetForm).formId;
  const payload: Record<string, unknown> = { ...sel.pk, TargetFormId: targetFormId, TargetOrgId: 0 };
  if (ruleId) payload.RuleId = ruleId;
  const raw = await callService(profile, DYNAMIC_FORM_SERVICE.push, [formId, JSON.stringify(payload)]);
  return extractBusinessResult(raw, '下推');
}
