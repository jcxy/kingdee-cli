#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import { Command, CommanderError } from 'commander';
import {
  ConfigError,
  configFilePath,
  listProfiles,
  resolveProfile,
  saveConfig,
  templateConfig,
  type AccessMode,
} from './config.js';
import { KdsvcError, login } from './kdsvc.js';
import {
  executeMetadata,
  executeQuery,
  executeView,
  rowsToObjects,
  type QueryOptions,
} from './read.js';
import { listAliases } from './alias.js';
import { configDir, type Profile } from './config.js';
import { ChainStepError, DEFAULT_CHAIN, runDeleteChain } from './chain.js';
import { buildConfigInteractively } from './config-wizard.js';
import type { AppConfig } from './config.js';
import {
  DEFAULT_MAX_ROWS,
  runCount,
  runQueryAll,
  runQueryFile,
  runQueryRange,
  type Granularity,
} from './bulk.js';
import {
  DYNAMIC_FORM_SERVICE,
} from './kdsvc.js';
import {
  DEFAULT_MAX_COUNT,
  assertWriteAllowed,
  confirmOrDryRun,
  executeCustomOperation,
  executePkOperation,
  executePush,
  executeSave,
  parseMaxCount,
  resolveSelection,
} from './write.js';
import { EXIT_CODES, type CliOutput, type ExitCode } from './exit-codes.js';

const program = new Command();

/** 统一 JSON 输出：紧凑为默认，--pretty 美化（人类排查用） */
let pretty = false;
function emit<T>(output: CliOutput<T>): void {
  const json = JSON.stringify(output, null, pretty ? 2 : 0);
  process.stdout.write(json + '\n');
}

function fail(
  command: string,
  code: ExitCode,
  message: string,
  hints?: string[],
  /** 失败时仍值得输出的部分成果（data+error 并存，spec 契约） */
  data?: unknown,
): never {
  // 复用 emit 以保留 --pretty；不再直接 process.exit：Windows 下 stdout 管道写入
  // 是异步的，强制退出会中断 pending write 触发 fail-fast（退出码 0xC0000409）。
  // 改为设置退出码并抛信号量，让进程自然退出（Node 会先冲刷完 stdout）。
  emit({ ok: false, command, data, error: { code, message, hints } });
  process.exitCode = code;
  throw new ExitSignal(message);
}

/** fail() 的控制流信号：穿透到顶层后安静收场，退出码由 process.exitCode 决定 */
class ExitSignal extends Error {}

async function run<T>(command: string, fn: () => Promise<T>): Promise<void> {
  try {
    const data = await fn();
    emit({ ok: true, command, data });
  } catch (e) {
    // fn 内部已自行 emit 并抛出信号量（如 delete-chain 的失败报告），直接透传
    if (e instanceof ExitSignal) throw e;
    if (e instanceof KdsvcError) {
      fail(command, e.code, e.message, e.hints, e.data);
    }
    if (e instanceof ConfigError) {
      fail(command, EXIT_CODES.PARAM_ERROR, e.message);
    }
    fail(
      command,
      EXIT_CODES.PARAM_ERROR,
      e instanceof Error ? e.message : String(e),
    );
  }
}

// 版本号单一事实源：package.json（发布物根目录），避免硬编码与发版脱节
const pkgVersion = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

program.name('kd').description('agent 优先的金蝶云星空 K3Cloud CLI').version(pkgVersion);

program
  .option('--profile <name>', '选择配置 profile（默认取 default-profile）')
  .option('--mode <mode>', '临时覆盖访问模式：readonly | readwrite')
  .option('--pretty', '美化输出（人类可读）')
  .hook('preAction', () => {
    pretty = program.opts().pretty === true;
    const mode = program.opts().mode;
    if (mode && mode !== 'readonly' && mode !== 'readwrite') {
      fail('global', EXIT_CODES.PARAM_ERROR, `未知 --mode: ${mode}（支持 readonly | readwrite）`);
    }
  });

function globalOpts() {
  return program.opts<{ profile?: string; mode?: string; pretty?: boolean }>();
}

const queryOpts = (cmd: Command) =>
  cmd
    .requiredOption('--form <form>', '单据别名（如 sales-order）或金蝶 formId')
    .option('--fields <keys>', '逗号分隔的字段 key 集合（默认 FID）')
    .option('--filter <expr>', '过滤条件，如 FBillNo = \'XSDD0001\'')
    .option('--order <expr>', '排序，如 FDate desc')
    .option('--limit <n>', '最大返回行数（默认 100）')
    .option('--start <n>', '起始行索引（分页用，默认 0）');

const config = program.command('config').description('配置管理');

config
  .command('init')
  .description(
    '创建配置文件（终端下默认交互式逐项问答；--template 跳过交互用模板；agent/CI 非 TTY 自动用模板）',
  )
  .option('--force', '覆盖已存在的配置文件')
  .option('--template', '不进入交互，直接写入内置模板（原 config init 行为）')
  .option('--interactive', '强制进入交互式向导（供脚本/测试用管道喡答案）')
  .action((opts) =>
    run('config-init', async () => {
      // 三态：--template 模板；TTY 或 --interactive 向导；其余（agent/CI 管道）模板
      const useWizard =
        opts.template !== true &&
        (opts.interactive === true || process.stdin.isTTY === true);
      // 预检：交互式向导若问完 9 问才报"文件已存在"，用户被迫重答全部问题
      const existingFile = configFilePath();
      if (fs.existsSync(existingFile) && opts.force !== true) {
        throw new ConfigError(`配置文件已存在: ${existingFile}（使用 --force 覆盖）`);
      }
      let config: AppConfig;
      if (useWizard) {
        const rl = readline.createInterface({
          input: process.stdin,
          // 提示与回显必须走 stderr：stdout 是纯 JSON 契约，向导交互不得污染
          output: process.stderr,
          terminal: false,
        });
        // 预读竞态防护：管道输入可能在首个提问前全部到达。rl.question() 只在
        // 调用瞬间监听 line，错过已 emit 的行会永久挂起。因此创建后同步挂
        // line 监听入队，提问时从队列取；EOF 时明确报错而非静默退出。
        const pending: string[] = [];
        let waiting: (() => void) | null = null;
        let closed = false;
        rl.on('line', (line) => {
          pending.push(line);
          waiting?.();
          waiting = null;
        });
        rl.on('close', () => {
          closed = true;
          waiting?.();
          waiting = null;
        });
        const nextLine = async (): Promise<string> => {
          if (pending.length > 0) return pending.shift()!;
          if (closed) throw new ConfigError('输入流已结束，配置向导中止（答案不足）');
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          if (pending.length === 0) throw new ConfigError('输入流已结束，配置向导中止（答案不足）');
          return pending.shift()!;
        };
        try {
          config = await buildConfigInteractively(async (label, defaultValue) => {
            const suffix = defaultValue !== undefined ? `（回车 = ${defaultValue}）` : '';
            process.stderr.write(`${label}${suffix}: `);
            return (await nextLine()).trim();
          });
        } finally {
          rl.close();
        }
      } else {
        config = templateConfig();
      }
      const file = saveConfig(config, opts.force === true);
      return {
        path: file,
        hint: useWizard
          ? '配置已生成，运行 kd config test 验证连通性'
          : '请编辑该文件填入真实凭据（或使用 KD_ 环境变量），然后运行 kd config test 验证',
      };
    }),
  );

config
  .command('list')
  .description('列出全部 profile（凭据脱敏）')
  .action(() => run('config-list', async () => listProfiles()));

config
  .command('test')
  .description('验证当前 profile 的连通性与凭据（执行一次真实登录）')
  .action(() =>
    run('config-test', async () => {
      const { name, profile } = resolveProfile(globalOpts().profile);
      if (globalOpts().mode) profile.mode = globalOpts().mode as AccessMode;
      const started = Date.now();
      await login(profile);
      return {
        profile: name,
        'server-url': profile['server-url'],
        'acct-id': profile['acct-id'],
        auth: profile.auth,
        mode: profile.mode,
        latencyMs: Date.now() - started,
      };
    }),
  );

program
  .command('aliases')
  .description('列出已知 formId 别名表（常用单据）')
  .action(() => run('aliases', async () => listAliases()));

queryOpts(
  program
    .command('query')
    .description('查询单据列表（返回二维数组，列序与 --fields 一致）'),
).action((opts: QueryOptions) =>
  run('query', async () => executeQuery(globalOpts().profile, opts)),
);

queryOpts(
  program
    .command('query-json')
    .description('查询单据列表（按字段名 zip 成对象数组，agent 友好）'),
).action((opts: QueryOptions) =>
  run('query-json', async () => {
    const r = await executeQuery(globalOpts().profile, opts);
    return { ...r, rows: rowsToObjects(r.fieldKeys, r.rows) };
  }),
);

// ---- 大数据量查询（T3） ----

const bulkOpts = (cmd: Command) =>
  cmd
    .requiredOption('--form <form>', '单据别名（如 sales-order）或金蝶 formId')
    .option('--fields <keys>', '逗号分隔的字段 key 集合（默认 FID）')
    .option('--filter <expr>', '过滤条件，如 FDate >= \'2026-01-01\'')
    .option('--order <expr>', '排序，如 FDate desc');

/** --max 行数上限解析（各命令默认值不同，见 DEFAULT_MAX_ROWS） */
function parseMax(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max 必须是正整数，收到: ${raw}`);
  }
  return n;
}

/** 大数据量查询公共参数 + 行数上限；各命令自行接 action（命令名与实现不同） */
const countOpts = (cmd: Command) =>
  bulkOpts(cmd).option('--max <n>', '安全上限（各命令默认值不同，见帮助）');

countOpts(
  program
    .command('count')
    .description('探测结果行数（轻量 FID 分页计数，拉全量前评估代价）'),
).action((opts) =>
  run('count', async () =>
    runCount(writeProfile(), {
      ...opts,
      maxRows: parseMax(opts.max, DEFAULT_MAX_ROWS.count),
    }),
  ),
);

countOpts(
  program
    .command('query-all')
    .description('自动翻页拉完全部结果并合并（受 --max 保护，防意外拉爆）'),
).action((opts) =>
  run('query-all', async () =>
    runQueryAll(writeProfile(), {
      ...opts,
      maxRows: parseMax(opts.max, DEFAULT_MAX_ROWS.queryAll),
    }),
  ),
);

countOpts(
  program
    .command('query-file')
    .description('流式导出到文件（ndjson/csv 逐页落盘，不撑爆内存）')
    .requiredOption('--out <file>', '输出文件路径')
    .option('--format <format>', '输出格式：ndjson | csv（默认 ndjson）', 'ndjson'),
).action((opts) =>
  run('query-file', async () => {
    const format = opts.format as string;
    if (format !== 'ndjson' && format !== 'csv') {
      throw new Error(`--format 只支持 ndjson | csv，收到: ${format}`);
    }
    return runQueryFile(writeProfile(), {
      ...opts,
      format,
      maxRows: parseMax(opts.max, DEFAULT_MAX_ROWS.queryFile),
    });
  }),
);

countOpts(
  program
    .command('query-range')
    .description('按日期自动分片（month/week/day）+ 翻页，跨月跨年可靠拉取')
    .requiredOption('--from <date>', '起始日期（YYYY-MM-DD，含）')
    .requiredOption('--to <date>', '截止日期（YYYY-MM-DD，含）')
    .option('--granularity <g>', '分片粒度：month | week | day（默认 month）', 'month')
    .option('--date-field <key>', '日期字段 key（默认 FDate）'),
).action((opts) =>
  run('query-range', async () =>
    runQueryRange(writeProfile(), {
      ...opts,
      granularity: opts.granularity as Granularity,
      maxRows: parseMax(opts.max, DEFAULT_MAX_ROWS.queryRange),
    }),
  ),
);


program
  .command('view')
  .description('查看单张单据完整数据')
  .requiredOption('--form <form>', '单据别名或金蝶 formId')
  .option('--id <id>', '单据内码（与 --number 二选一）')
  .option('--number <no>', '单据编号（与 --id 二选一）')
  .action((opts) =>
    run('view', async () => executeView(globalOpts().profile, opts)),
  );

program
  .command('metadata')
  .description('查询表单元数据（字段、实体结构，用于构造 filter/fields）')
  .requiredOption('--form <form>', '单据别名或金蝶 formId')
  .action((opts) =>
    run('metadata', async () => executeMetadata(globalOpts().profile, opts.form)),
  );

// ---- 写入原语（T4）：readonly 闸门 + 批量熔断 + 危险命令 dry-run ----

/** 当前生效 profile（应用 --mode 全局覆盖） */
function writeProfile(): Profile {
  const { profile } = resolveProfile(globalOpts().profile);
  if (globalOpts().mode) profile.mode = globalOpts().mode as AccessMode;
  return profile;
}

const selOpts = (cmd: Command) =>
  cmd
    .requiredOption('--form <form>', '单据别名或金蝶 formId')
    .option('--ids <ids>', '目标单据内码，逗号分隔（与 --numbers/--filter 三选一）')
    .option('--numbers <nos>', '目标单据编号，逗号分隔（与 --ids/--filter 三选一）')
    .option('--filter <expr>', '过滤条件；先解析影响面再执行（与 --ids/--numbers 三选一）')
    .option('--max-count <n>', `批量上限（默认 ${DEFAULT_MAX_COUNT}）`);

/** 危险命令公共流程：readonly 闸门 → 影响面解析/熔断 → 确认 → 执行 */
function dangerousWrite(command: string, action: string, service: string) {
  return (opts: {
    form: string;
    ids?: string;
    numbers?: string;
    filter?: string;
    maxCount?: string;
    yes?: boolean;
  }) =>
    run(command, async () => {
      const profile = writeProfile();
      assertWriteAllowed(profile);
      const sel = await resolveSelection(profile, opts.form, {
        ids: opts.ids,
        numbers: opts.numbers,
        filter: opts.filter,
        maxCount: parseMaxCount(opts.maxCount),
      });
      const gate = await confirmOrDryRun(sel.refs, { yes: opts.yes, action });
      if (!gate.executed) {
        return {
          dryRun: true,
          formId: sel.formId,
          affected: sel.refs,
          wouldSend: sel.pk,
          hint: '未执行任何写操作；确认影响面后加 --yes 真正执行',
        };
      }
      return executePkOperation(profile, service, sel, action);
    });
}

program
  .command('save')
  .description('新增单据（--data 传单据 JSON）')
  .requiredOption('--form <form>', '单据别名或金蝶 formId')
  .requiredOption('--data <json>', '单据 JSON 字符串（与金蝶 Save 接口的 data 参数一致）')
  .action((opts) =>
    run('save', async () => {
      const profile = writeProfile();
      assertWriteAllowed(profile);
      // 形状校验：必须是 JSON 对象（金蝶 Save 的 data 为单据对象 JSON 串）
      const bill = JSON.parse(opts.data);
      if (bill === null || typeof bill !== 'object' || Array.isArray(bill)) {
        throw new Error('--data 必须是单据 JSON 对象（如 {"FBillNo":"XSDD0001",...}）');
      }
      return executeSave(profile, opts.form, opts.data);
    }),
  );

selOpts(program.command('submit').description('提交单据')).action((opts) =>
  run('submit', async () => {
    const profile = writeProfile();
    assertWriteAllowed(profile);
    const sel = await resolveSelection(profile, opts.form, {
      ids: opts.ids,
      numbers: opts.numbers,
      filter: opts.filter,
      maxCount: parseMaxCount(opts.maxCount),
    });
    return executePkOperation(profile, DYNAMIC_FORM_SERVICE.submit, sel, '提交');
  }),
);

selOpts(program.command('audit').description('审核单据')).action((opts) =>
  run('audit', async () => {
    const profile = writeProfile();
    assertWriteAllowed(profile);
    const sel = await resolveSelection(profile, opts.form, {
      ids: opts.ids,
      numbers: opts.numbers,
      filter: opts.filter,
      maxCount: parseMaxCount(opts.maxCount),
    });
    return executePkOperation(profile, DYNAMIC_FORM_SERVICE.audit, sel, '审核');
  }),
);

selOpts(
  program
    .command('unaudit')
    .description('反审核单据（危险命令：默认 dry-run，--yes 执行）')
    .option('--yes', '跳过确认，真正执行'),
).action(dangerousWrite('unaudit', '反审核', DYNAMIC_FORM_SERVICE.unAudit));

selOpts(
  program
    .command('delete')
    .description('删除单据（危险命令：默认 dry-run，--yes 执行）')
    .option('--yes', '跳过确认，真正执行'),
).action(dangerousWrite('delete', '删除', DYNAMIC_FORM_SERVICE.delete));

selOpts(
  program
    .command('execute-operation')
    .description('执行自定义操作（禁用/反禁用等）')
    .requiredOption('--op <opNumber>', '操作编码，如 Forbid / UnForbid'),
).action((opts) =>
  run('execute-operation', async () => {
    const profile = writeProfile();
    assertWriteAllowed(profile);
    const sel = await resolveSelection(profile, opts.form, {
      ids: opts.ids,
      numbers: opts.numbers,
      filter: opts.filter,
      maxCount: parseMaxCount(opts.maxCount),
    });
    return executeCustomOperation(profile, opts.form, opts.op, sel);
  }),
);

selOpts(
  program
    .command('push')
    .description('下推生成下游单据')
    .requiredOption('--target-form <form>', '目标单据别名或 formId')
    .option('--rule <ruleId>', '转换规则 ID（可选；不传由金蝶按默认规则）'),
).action((opts) =>
  run('push', async () => {
    const profile = writeProfile();
    assertWriteAllowed(profile);
    const sel = await resolveSelection(profile, opts.form, {
      ids: opts.ids,
      numbers: opts.numbers,
      filter: opts.filter,
      maxCount: parseMaxCount(opts.maxCount),
    });
    return executePush(profile, opts.form, sel, opts.targetForm, opts.rule);
  }),
);

// ---- 复合命令（T5）：delete-chain 月结删单 ----

program
  .command('delete-chain')
  .description(
    '按追踪字段反查链条单据，逆下推方向逐环节反审核+删除（危险命令：默认 dry-run，--yes 执行）',
  )
  .requiredOption('--trace-id <id>', '追踪 ID（站点自定义追踪字段的值，如外部单据标识）')
  .option('--trace-field <key>', '追踪字段 key（覆盖链条配置；默认见 chains.yaml / DEFAULT_TRACE_FIELD）')
  .option('--chain <name>', `链条名称（默认 ${DEFAULT_CHAIN}；可用 chains.yaml 扩展）`)
  .option('--max-count <n>', `批量上限，对链条总量生效（默认 ${DEFAULT_MAX_COUNT}）`)
  .option('--yes', '跳过确认，真正执行')
  .action((opts) =>
    run('delete-chain', async () => {
      const profile = writeProfile();
      assertWriteAllowed(profile);
      try {
        return await runDeleteChain(profile, configDir(), {
          traceId: opts.traceId,
          traceField: opts.traceField,
          chainName: opts.chain,
          maxCount: parseMaxCount(opts.maxCount),
          yes: opts.yes,
        });
      } catch (e) {
        // 环节失败：报告作为 data 随 error 一并输出，让 agent 看到完整执行轨迹
        if (e instanceof ChainStepError) {
          emit({
            ok: false,
            command: 'delete-chain',
            data: e.report,
            error: { code: e.code, message: e.message, hints: e.hints },
          });
          process.exitCode = e.code;
          throw new ExitSignal(e.message);
        }
        throw e;
      }
    }),
  );

// commander 自身的解析错误也要遵守 stdout-JSON 契约与退出码约定。
// 注意：commander 的 _exit 不会向父命令传播——exitOverride 必须递归应用到
// 全部子命令，否则子命令上的错误（如未知选项）会直接 process.exit(1) 绕过契约。
function applyExitOverrideDeep(cmd: Command): void {
  cmd.exitOverride();
  cmd.commands.forEach(applyExitOverrideDeep);
}
applyExitOverrideDeep(program);
program
  .parseAsync(process.argv)
  .catch((e) => {
    if (e instanceof ExitSignal) return;
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') {
        process.exitCode = EXIT_CODES.OK; // --help/--version 已正常输出
        return;
      }
      fail('global', EXIT_CODES.PARAM_ERROR, e.message);
    }
    fail('global', EXIT_CODES.PARAM_ERROR, e instanceof Error ? e.message : String(e));
  })
  .catch((e) => {
    // 吸收 fail() 抛出的 ExitSignal；其余异常照常抛出
    if (!(e instanceof ExitSignal)) throw e;
  });
