/**
 * delete-chain 链条定义与执行。
 * 链条 forms 顺序即执行顺序（下游 → 上游）：默认链先删应收单，最后删销售订单。
 * 内置默认链 + ~/.kingdee-cli/chains.yaml 扩展（同名覆盖内置，无需改代码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { resolveFormArg } from './read.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import {
  DYNAMIC_FORM_SERVICE,
  KdsvcError,
  assertBusinessSuccess,
  callService,
  login,
} from './kdsvc.js';
import type { Profile } from './config.js';
import { confirmOrDryRun, executePkOperation, type BillRef } from './write.js';

export interface ChainDef {
  description?: string;
  /** formId 别名/编码列表，顺序 = 执行顺序（下游 → 上游） */
  forms: string[];
  /** 反查用的追踪字段 key（自定义字段存外部追踪 ID）；缺省用 DEFAULT_TRACE_FIELD */
  traceField?: string;
}

export const DEFAULT_CHAIN = 'month-end';

/** 追踪字段默认 key：站点通常有自定义字段存外部单据标识，可在 chains.yaml 里按链覆盖 */
export const DEFAULT_TRACE_FIELD = 'FTraceId';

export const BUILTIN_CHAINS: Record<string, ChainDef> = {
  'month-end': {
    description: '月结删单：应收单 → 销售出库单 → 销售订单',
    forms: ['ar-receivable', 'sal-outstock', 'sales-order'],
  },
};

/**
 * 加载链条定义：内置链 + chains.yaml（{chains: {<name>: {description?, forms: [...]}}}）。
 * chains.yaml 同名链覆盖内置链；文件不存在时仅返回内置链。
 */
export function loadChains(dir: string): Record<string, ChainDef> {
  const chains: Record<string, ChainDef> = { ...BUILTIN_CHAINS };
  const file = path.join(dir, 'chains.yaml');
  if (!fs.existsSync(file)) return chains;

  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`链条配置文件格式无效（YAML 解析失败）: ${file}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`链条配置文件格式无效（期望 {chains: {...}}）: ${file}`);
  }
  const userChains = (raw as { chains?: unknown }).chains;
  if (userChains === undefined) return chains;
  if (userChains === null || typeof userChains !== 'object' || Array.isArray(userChains)) {
    throw new Error(`链条配置文件格式无效（chains 必须是映射）: ${file}`);
  }

  for (const [name, value] of Object.entries(userChains as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`链条「${name}」格式无效（期望 {description?, forms: [...], traceField?})`);
    }
    const def = value as { description?: unknown; forms?: unknown; traceField?: unknown };
    if (
      !Array.isArray(def.forms) ||
      def.forms.length === 0 ||
      !def.forms.every((f) => typeof f === 'string' && f.trim())
    ) {
      throw new Error(`链条「${name}」格式无效（forms 必须是非空字符串数组）`);
    }
    chains[name] = {
      description: typeof def.description === 'string' ? def.description : undefined,
      forms: def.forms.map((f) => (f as string).trim()),
      traceField: typeof def.traceField === 'string' && def.traceField.trim() ? def.traceField.trim() : undefined,
    };
  }
  return chains;
}

export interface ChainStepReport {
  /** 链配置中的 form 别名 */
  form: string;
  formId: string;
  /** 未命中（未下推或不存在），跳过执行 */
  skipped?: boolean;
  refs?: BillRef[];
  unaudit?: { ok: true } | { ok: false; error: string };
  delete?: { ok: true } | { ok: false; error: string };
}

export interface ChainRunReport {
  chain: string;
  traceId: string;
  traceField: string;
  dryRun?: true;
  note?: string;
  hint?: string;
  steps: ChainStepReport[];
}

/** 某环节执行失败：携带已构建的部分报告，输出报告后按 code 退出 */
export class ChainStepError extends KdsvcError {
  constructor(
    readonly report: ChainRunReport,
    code: ExitCode,
    message: string,
    hints?: string[],
  ) {
    super(code, message, hints);
  }
}

/** 按追踪字段反查单环节单据（FID,FBillNo）；复用已持有会话 */
async function queryByTrace(
  profile: Profile,
  formId: string,
  traceId: string,
  traceField: string,
  maxCount: number,
  cookie: string,
): Promise<BillRef[]> {
  const raw = await callService(
    profile,
    DYNAMIC_FORM_SERVICE.executeBillQuery,
    [
      {
        FormId: formId,
        FieldKeys: 'FID,FBillNo',
        FilterString: `${traceField}='${traceId}'`,
        Limit: maxCount + 1,
        StartRow: 0,
      },
    ],
    cookie,
  );
  assertBusinessSuccess(raw, `链条反查（${formId}）`);
  if (!Array.isArray(raw) || !raw.every((row) => Array.isArray(row))) {
    throw new Error('金蝶查询响应不符合协议（期望二维数组）');
  }
  return (raw as unknown[][]).map((row) => ({
    id: row[0] == null ? '' : String(row[0]),
    number: row[1] == null ? null : String(row[1]),
  }));
}

/**
 * delete-chain 主流程：反查全链（降级跳过未命中环节）→ 总量熔断 →
 * 确认闸门（--yes/TTY/非 TTY dry-run）→ 逆下推方向逐环节反审核+删除。
 * 环节失败抛 ChainStepError（携带报告，exit 4）。
 */
export async function runDeleteChain(
  profile: Profile,
  configDirPath: string,
  opts: { traceId: string; traceField?: string; chainName?: string; maxCount: number; yes?: boolean },
): Promise<ChainRunReport> {
  if (opts.traceId.includes("'")) {
    throw new Error('--trace-id 不能包含单引号');
  }
  const chains = loadChains(configDirPath);
  const chainName = opts.chainName || DEFAULT_CHAIN;
  const chain = chains[chainName];
  if (!chain) {
    throw new Error(`未知链条「${chainName}」，可用链条: ${Object.keys(chains).join(', ')}`);
  }
  // 追踪字段解析优先级：CLI --trace-field > 链配置 traceField > 默认值
  const traceField = opts.traceField || chain.traceField || DEFAULT_TRACE_FIELD;

  // 全程只登一次，反查与执行复用会话
  const cookie = await login(profile);
  // 反查全链：未命中环节降级跳过，不中断
  const steps: ChainStepReport[] = [];
  let total = 0;
  for (const form of chain.forms) {
    const formId = resolveFormArg(form).formId;
    const refs = await queryByTrace(profile, formId, opts.traceId, traceField, opts.maxCount, cookie);
    if (refs.length === 0) {
      steps.push({ form, formId, skipped: true });
      continue;
    }
    total += refs.length;
    steps.push({ form, formId, refs });
  }
  if (total > opts.maxCount) {
    throw new KdsvcError(
      EXIT_CODES.MAX_COUNT_REACHED,
      `链条共影响 ${total} 张单据，超过批量上限 ${opts.maxCount}`,
      ['用 --max-count 显式提高上限（确认你知道自己在批量删除什么）'],
    );
  }

  const allRefs = steps.flatMap((s) => s.refs ?? []);
  if (total === 0) {
    // 全链未命中：执行无意义，直接输出报告提示核对 zwlf-id
    return {
      chain: chainName,
      traceId: opts.traceId,
      traceField,
      dryRun: true,
      note: '全链未命中任何单据，未执行写操作；请确认 --trace-id 与追踪字段配置是否正确',
      steps,
    };
  }

  const gate = await confirmOrDryRun(allRefs, { yes: opts.yes, action: '按链条删除' });
  if (!gate.executed) {
    return {
      chain: chainName,
      traceId: opts.traceId,
      traceField,
      dryRun: true,
      hint: '未执行任何写操作；确认影响面后加 --yes 真正执行',
      steps,
    };
  }

  const report: ChainRunReport = { chain: chainName, traceId: opts.traceId, traceField, steps };
  for (const step of steps) {
    if (step.skipped || !step.refs) continue;
    const sel = {
      formId: step.formId,
      refs: step.refs,
      pk: { Ids: step.refs.map((r) => r.id).join(',') },
    };
    try {
      await executePkOperation(
        profile,
        DYNAMIC_FORM_SERVICE.unAudit,
        sel,
        `反审核(${step.form})`,
        cookie,
      );
      step.unaudit = { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      step.unaudit = { ok: false, error };
      // 保留原始退出码语义：网络/超时（5，状态未知）≠ 金蝶业务拒绝（4，状态明确）
      const code = e instanceof KdsvcError ? e.code : EXIT_CODES.KINGDEE_REJECTED;
      throw new ChainStepError(
        report,
        code,
        `链条环节「${step.form}」反审核失败: ${error}；已停止后续环节`,
        [
          code === EXIT_CODES.KINGDEE_REJECTED
            ? '先 kd query 核对该单据当前状态（可能已反审核或被锁定）'
            : '网络类失败状态未知，恢复连通后重跑 delete-chain（探针会重新反查，已处理环节自动跳过）',
        ],
      );
    }
    try {
      await executePkOperation(
        profile,
        DYNAMIC_FORM_SERVICE.delete,
        sel,
        `删除(${step.form})`,
        cookie,
      );
      step.delete = { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      step.delete = { ok: false, error };
      const code = e instanceof KdsvcError ? e.code : EXIT_CODES.KINGDEE_REJECTED;
      throw new ChainStepError(
        report,
        code,
        `链条环节「${step.form}」删除失败: ${error}；已停止后续环节`,
        [
          // 批量部分成功（IsSuccess=false 但 SuccessEntitys 非空）时：
          // 重跑安全——探针重新反查，已删除环节自动跳过，不存在重复删除
          code === EXIT_CODES.KINGDEE_REJECTED
            ? '反审核成功但删除失败时，可用 kd delete --ids 单独重试该环节'
            : '网络类失败状态未知，恢复连通后重跑 delete-chain（已处理环节自动跳过）',
        ],
      );
    }
  }
  return report;
}
