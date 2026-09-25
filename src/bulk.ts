/**
 * 大数据量查询（T3）：count / query-all / query-file / query-range。
 * 公共底座是 fetchAllPages 分页器：K3Cloud ExecuteBillQuery 单页上限 2000 行，
 * 自动翻页拉完；--max 达到上限时停止并明确报告（exit 7，data 携带已拉取部分）。
 * query-file 流式落盘（逐页写文件，不拼接大字符串），不撑爆内存。
 */
import fs from 'node:fs';
import { EXIT_CODES } from './exit-codes.js';
import {
  DYNAMIC_FORM_SERVICE,
  KdsvcError,
  assertBusinessSuccess,
  callService,
  login,
  type BillQueryParams,
} from './kdsvc.js';
import type { Profile } from './config.js';
import { resolveFormArg, parseFieldKeys } from './read.js';

/** K3Cloud ExecuteBillQuery 单次返回行数上限 */
export const PAGE_SIZE = 2000;

export const DEFAULT_MAX_ROWS = {
  count: 100_000,
  queryAll: 10_000,
  queryFile: 100_000,
  queryRange: 50_000,
} as const;

export interface BulkQueryBase {
  form: string;
  fields?: string;
  filter?: string;
  order?: string;
}

function buildBaseParams(o: BulkQueryBase): Omit<BillQueryParams, 'Limit' | 'StartRow'> {
  const keys = parseFieldKeys(o.fields);
  const params: Omit<BillQueryParams, 'Limit' | 'StartRow'> = {
    FormId: resolveFormArg(o.form).formId,
    // 净化后与 zip/表头同源，避免 ' FBillNo' 这类带空格的键取不到列
    FieldKeys: keys.length ? keys.join(',') : 'FID',
  };
  if (o.filter) params.FilterString = o.filter;
  if (o.order) params.OrderString = o.order;
  return params;
}

export interface PageFetchResult {
  /** collect 时为全量合并行；流式消费时为空数组 */
  rows: unknown[][];
  /** 实际拉取总行数 */
  fetched: number;
  /** 达到 maxRows 上限（可能未拉完） */
  truncated: boolean;
}

interface FetchAllPagesOptions {
  profile: Profile;
  base: Omit<BillQueryParams, 'Limit' | 'StartRow'>;
  /** 行数安全上限（熔断） */
  maxRows: number;
  /** 流式消费者（query-file 落盘）；返回后行不再持有 */
  onPage?: (rows: unknown[][], startRow: number) => Promise<void> | void;
  /** 是否在内存中收集全部行（query-all/query-range 需要；query-file 关闭） */
  collect: boolean;
}

/** 单页查询：请求形态精确（Limit/StartRow 由分页器控制），响应协议校验 */
async function queryPage(
  profile: Profile,
  base: Omit<BillQueryParams, 'Limit' | 'StartRow'>,
  limit: number,
  startRow: number,
  cookie: string,
): Promise<unknown[][]> {
  const raw = await callService(profile, DYNAMIC_FORM_SERVICE.executeBillQuery, [
    { ...base, Limit: limit, StartRow: startRow },
  ], cookie);
  assertBusinessSuccess(raw, '查询');
  if (!Array.isArray(raw) || !raw.every((row) => Array.isArray(row))) {
    throw new Error('金蝶查询响应不符合协议（期望二维数组）');
  }
  return raw as unknown[][];
}

/** 分页拉取器：翻页拉完或达到 maxRows；请求形态精确（Limit/StartRow 由本函数控制） */
export async function fetchAllPages(o: FetchAllPagesOptions): Promise<PageFetchResult> {
  const rows: unknown[][] = [];
  let fetched = 0;
  let startRow = 0;
  let truncated = false;
  // 全程只登一次：大数据量 N 页放大，逐页登录会双倍请求数并触发会话/限流风险
  const cookie = await login(o.profile);
  // 最后一页返回行数 < Limit 时自然结束；达到上限时多探 1 行消歧
  // （数据集恰好等于 --max 不误报，count 的行数才是准确的）
  for (;;) {
    const limit = Math.min(PAGE_SIZE, o.maxRows - fetched);
    const page = await queryPage(o.profile, o.base, limit, startRow, cookie);
    fetched += page.length;
    if (o.onPage) await o.onPage(page, startRow);
    if (o.collect) rows.push(...page);
    startRow += page.length;
    if (page.length < limit) break;
    if (fetched >= o.maxRows) {
      truncated = (await queryPage(o.profile, o.base, 1, startRow, cookie)).length > 0;
      break;
    }
  }
  return { rows, fetched, truncated };
}

/** 达到上限时的统一错误：data 携带已拉取部分，agent 可见已取得的成果 */
export function maxRowsReached(
  context: string,
  fetched: number,
  maxRows: number,
  extra: Record<string, unknown>,
): KdsvcError {
  return new KdsvcError(
    EXIT_CODES.MAX_COUNT_REACHED,
    `${context}达到安全上限 ${maxRows} 行后停止（已获取 ${fetched} 行，可能未拉完）`,
    ['调整 --filter 缩小范围，或用 --max 显式提高上限'],
    extra,
  );
}

/** count：探测结果行数（拉轻量字段 FID 分页计数，拉全量前评估代价） */
export async function runCount(
  profile: Profile,
  o: BulkQueryBase & { maxRows: number },
): Promise<{ count: number | null; atLeast?: number }> {
  const base = buildBaseParams({ ...o, fields: 'FID' });
  const r = await fetchAllPages({ profile, base, maxRows: o.maxRows, collect: false });
  if (r.truncated) {
    throw maxRowsReached('行数探测', r.fetched, o.maxRows, { count: null, atLeast: r.fetched });
  }
  return { count: r.fetched };
}

/** query-all：自动翻页拉完并合并（受 --max 保护） */
export async function runQueryAll(
  profile: Profile,
  o: BulkQueryBase & { maxRows: number },
): Promise<{ formId: string; fieldKeys: string[]; rows: unknown[][]; fetched: number; truncated?: true }> {
  const base = buildBaseParams(o);
  const r = await fetchAllPages({ profile, base, maxRows: o.maxRows, collect: true });
  const result = {
    formId: base.FormId,
    fieldKeys: base.FieldKeys.split(','),
    rows: r.rows,
    fetched: r.fetched,
  };
  if (r.truncated) {
    throw maxRowsReached('查询', r.fetched, o.maxRows, { ...result, truncated: true });
  }
  return result;
}

// ---- CSV 序列化（RFC 4180 简化实现） ----

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export type FileFormat = 'ndjson' | 'csv';

/** query-file：流式落盘（ndjson 每行一个对象 / csv 表头+行），逐页写不撑爆内存 */
export async function runQueryFile(
  profile: Profile,
  o: BulkQueryBase & { maxRows: number; format: FileFormat; out: string },
): Promise<{ file: string; format: FileFormat; rows: number; truncated?: true }> {
  const base = buildBaseParams(o);
  const fieldKeys = base.FieldKeys.split(',');
  const stream = fs.createWriteStream(o.out, { encoding: 'utf8' });
  // 流错误（--out 路径无效/权限/磁盘满）是异步发出的，必须路由进 await 链，
  // 否则进程以原生堆栈崩溃、stdout 无 JSON 行；晚到且无人等待的错误不升级为 unhandledRejection
  const streamError = new Promise<never>((_, reject) => stream.once('error', reject));
  streamError.catch(() => {});
  const writeChunk = (chunk: string): Promise<void> =>
    Promise.race([
      new Promise<void>((resolve) => {
        if (stream.write(chunk)) resolve();
        else stream.once('drain', resolve);
      }),
      streamError,
    ]);

  try {
    if (o.format === 'csv') {
      await writeChunk(csvLine(fieldKeys) + '\n');
    }
    let written = 0;
    const r = await fetchAllPages({
      profile,
      base,
      maxRows: o.maxRows,
      collect: false,
      onPage: async (page) => {
        if (o.format === 'ndjson') {
          await writeChunk(
            page.map((row) => JSON.stringify(Object.fromEntries(fieldKeys.map((k, i) => [k, row[i]])))).join('\n') + '\n',
          );
        } else {
          await writeChunk(page.map((row) => csvLine(row)).join('\n') + '\n');
        }
        written += page.length;
      },
    });
    await new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const result = { file: o.out, format: o.format, rows: written };
    if (r.truncated) {
      throw maxRowsReached('导出', r.fetched, o.maxRows, { ...result, truncated: true });
    }
    return result;
  } finally {
    stream.destroy();
  }
}

// ---- 日期分片（纯函数，月末/跨年边界正确性在此保证） ----

export type Granularity = 'day' | 'week' | 'month';

export interface DateRange {
  /** YYYY-MM-DD，闭区间 */
  from: string;
  to: string;
}

function parseDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`日期格式必须是 YYYY-MM-DD，收到: ${s}`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  // NaN 检查拦不住 2026-02-30 这类滚动日期（会静默变成 03-02），回环校验兜底
  if (Number.isNaN(d.getTime()) || fmtDate(d) !== s) throw new Error(`日期无效: ${s}`);
  return d;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** 当月最后一天（UTC） */
function monthEnd(y: number, m1: number): Date {
  return new Date(Date.UTC(y, m1, 0));
}

/**
 * 闭区间 [from, to] 按粒度切分：
 * day = 每日一片；week = 从 from 起每 7 天一片；month = 自然月边界切分。
 * 首片从 from 起、末片到 to 止，中间片为完整自然月。
 */
export function splitDateRange(from: string, to: string, granularity: Granularity): DateRange[] {
  if (granularity !== 'day' && granularity !== 'week' && granularity !== 'month') {
    throw new Error(`--granularity 只支持 month | week | day，收到: ${granularity}`);
  }
  const start = parseDate(from);
  const end = parseDate(to);
  if (start > end) throw new Error(`--from（${from}）不能晚于 --to（${to}）`);

  if (granularity === 'day') {
    const ranges: DateRange[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      ranges.push({ from: fmtDate(d), to: fmtDate(d) });
    }
    return ranges;
  }

  if (granularity === 'week') {
    const ranges: DateRange[] = [];
    let cursor = start;
    while (cursor <= end) {
      const rangeEnd = addDays(cursor, 6) < end ? addDays(cursor, 6) : end;
      ranges.push({ from: fmtDate(cursor), to: fmtDate(rangeEnd) });
      cursor = addDays(rangeEnd, 1);
    }
    return ranges;
  }

  // month：自然月切分
  const ranges: DateRange[] = [];
  let cursor = start;
  while (cursor <= end) {
    const me = monthEnd(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
    const rangeEnd = me < end ? me : end;
    ranges.push({ from: fmtDate(cursor), to: fmtDate(rangeEnd) });
    cursor = addDays(rangeEnd, 1);
  }
  return ranges;
}

export interface RangeStepReport {
  from: string;
  to: string;
  count: number;
  rows: unknown[][];
}

/** query-range：按日期分片，每片内自动翻页拉完；总行数受 --max 保护 */
export async function runQueryRange(
  profile: Profile,
  o: BulkQueryBase & {
    maxRows: number;
    from: string;
    to: string;
    granularity: Granularity;
    dateField?: string;
  },
): Promise<{ granularity: Granularity; ranges: RangeStepReport[]; total: number }> {
  const ranges = splitDateRange(o.from, o.to, o.granularity);
  const dateField = o.dateField && o.dateField.trim() ? o.dateField.trim() : 'FDate';
  const base = buildBaseParams(o);
  const userFilter = base.FilterString ? `(${base.FilterString}) and ` : '';

  const steps: RangeStepReport[] = [];
  let total = 0;
  let remaining = o.maxRows;
  for (const r of ranges) {
    const slice = {
      ...base,
      FilterString: `${userFilter}(${dateField} >= '${r.from}' and ${dateField} <= '${r.to}')`,
    };
    const fetched = await fetchAllPages({
      profile,
      base: slice,
      maxRows: remaining,
      collect: true,
    });
    total += fetched.fetched;
    steps.push({ from: r.from, to: r.to, count: fetched.fetched, rows: fetched.rows });
    if (fetched.truncated) {
      throw maxRowsReached('按日期分片查询', total, o.maxRows, {
        ranges: steps,
        total,
        truncatedRange: { ...r },
      });
    }
    remaining = o.maxRows - total;
  }
  return { granularity: o.granularity, ranges: steps, total };
}
