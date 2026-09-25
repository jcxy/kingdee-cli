import { resolveFormId } from './alias.js';
import { resolveProfile } from './config.js';
import {
  DYNAMIC_FORM_SERVICE,
  assertBusinessSuccess,
  callService,
  extractBusinessResult,
  type BillQueryParams,
} from './kdsvc.js';

export interface QueryOptions {
  form: string;
  fields?: string;
  filter?: string;
  order?: string;
  limit?: string;
  start?: string;
}

export interface ViewOptions {
  form: string;
  id?: string;
  number?: string;
}

/** 解析 --form：别名优先；未知则透传并在 stderr 提示（stdout 保持纯 JSON 契约） */
export function resolveFormArg(input: string): { formId: string; label?: string } {
  const r = resolveFormId(input);
  if (!r.known) {
    process.stderr.write(
      `[kd] 提示: "${input}" 不在别名表中，已按原样传给金蝶；可用 kd aliases 查看已知别名\n`,
    );
    return { formId: r.formId };
  }
  return { formId: r.formId, label: r.matched?.label };
}

function profile(profileName?: string) {
  return resolveProfile(profileName).profile;
}

function buildQueryParams(o: QueryOptions): BillQueryParams {
  const fieldKeys = parseFieldKeys(o.fields);
  const params: BillQueryParams = {
    FormId: resolveFormArg(o.form).formId,
    // 下发的 FieldKeys 与 zip 用的键列表必须恒等，否则 query-json 列值会静默错位
    FieldKeys: fieldKeys.length ? fieldKeys.join(',') : 'FID',
    Limit: parsePositiveInt(o.limit, '--limit', 100),
    StartRow: parsePositiveInt(o.start, '--start', 0),
  };
  if (o.filter) params.FilterString = o.filter;
  if (o.order) params.OrderString = o.order;
  return params;
}

/** 净化字段列表：去空格、去空段（用户常写 'FID, FBillNo'）；供 bulk 复用保持键列表同源 */
export function parseFieldKeys(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    const err = new Error(`${flag} 必须是非负整数，收到: ${raw}`);
    (err as { skipStack?: boolean }).skipStack = true;
    throw err;
  }
  return n;
}

/** ExecuteBillQuery：返回 [fieldKeys, rows 二维数组] */
export async function executeQuery(
  profileName: string | undefined,
  o: QueryOptions,
): Promise<{ formId: string; fieldKeys: string[]; rows: unknown[][] }> {
  const params = buildQueryParams(o);
  const fieldKeys = params.FieldKeys.split(',');
  const raw = await callService(
    profile(profileName),
    DYNAMIC_FORM_SERVICE.executeBillQuery,
    [params],
  );
  assertBusinessSuccess(raw, '查询');
  if (!Array.isArray(raw) || !raw.every((row) => Array.isArray(row))) {
    throw new Error('金蝶查询响应不符合协议（期望二维数组）');
  }
  return { formId: params.FormId, fieldKeys, rows: raw as unknown[][] };
}

/** query 的对象形态：按 fieldKeys 把二维数组 zip 成对象数组 */
export function rowsToObjects(fieldKeys: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(fieldKeys.map((k, i) => [k, row[i]])));
}

/** View：按 Id 或 Number 取单据完整数据 */
export async function executeView(
  profileName: string | undefined,
  o: ViewOptions,
): Promise<unknown> {
  const formId = resolveFormArg(o.form).formId;
  if (o.id && o.number) {
    const err = new Error('--id 与 --number 只能二选一');
    (err as { skipStack?: boolean }).skipStack = true;
    throw err;
  }
  if (!o.id && !o.number) {
    const err = new Error('view 需要 --id <单据内码> 或 --number <单据编号> 之一');
    (err as { skipStack?: boolean }).skipStack = true;
    throw err;
  }
  const pk = o.id ? { Id: o.id } : { Number: o.number };
  const raw = await callService(profile(profileName), DYNAMIC_FORM_SERVICE.view, [
    formId,
    JSON.stringify(pk),
  ]);
  return extractBusinessResult(raw, '单据查看');
}

/** QueryBusinessInfo：取表单元数据（字段、实体结构） */
export async function executeMetadata(
  profileName: string | undefined,
  form: string,
): Promise<unknown> {
  const formId = resolveFormArg(form).formId;
  const raw = await callService(profile(profileName), DYNAMIC_FORM_SERVICE.queryBusinessInfo, [
    { FormId: formId },
  ]);
  return extractBusinessResult(raw, '元数据查询');
}
