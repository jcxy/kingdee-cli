import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, type StubServer } from './stub-server.js';
import { stringify } from 'yaml';
import { splitDateRange } from '../src/bulk.js';

/**
 * 唯一接缝：CLI 进程边界。
 * 以子进程运行构建产物 dist/cli.js，断言 stdout JSON、stderr 与退出码。
 */
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

function runCli(args: string[], env: Record<string, string>, stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    if (stdin !== undefined) child.stdin.end(stdin, 'utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

let stub: StubServer;
let configDir: string;
const baseEnv = () => ({ KD_CONFIG_DIR: configDir });

beforeEach(async () => {
  stub = await startStubServer();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-test-'));
});

afterEach(async () => {
  await stub.close();
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  const config = {
    'default-profile': 'dev',
    profiles: {
      dev: {
        'server-url': stub.url,
        'acct-id': 'acct-001',
        auth: 'app',
        username: 'tester',
        'app-id': 'app-001',
        'app-secret': 'good-secret',
        lcid: 2052,
        mode: 'readwrite',
        ...overrides,
      },
    },
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    stringify(config),
    'utf8',
  );
}

describe('CLI 进程边界：基础', () => {
  it('--version 输出与 package.json 同步（单一事实源，不再硬编码）', async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const r = await runCli(['--version'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });
});

describe('CLI 进程边界：config', () => {
  it('引用不存在的 profile：明确报"profile 不存在"并列出现有名称（校准反馈修正）', async () => {
    await writeConfig();
    const r = await runCli(['config', 'test', '--profile', 'dev-app'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('profile "dev-app" 不存在');
    expect(r.json.error.message).toContain('现有: dev');
  });

  it('profile 不存在但 KD_ 环境变量齐全：仍可运行（CI 场景不依赖文件内同名 profile）', async () => {
    await writeConfig();
    const env = {
      ...baseEnv(),
      KD_SERVER_URL: stub.url,
      KD_ACCT_ID: 'acct-001',
      KD_APP_ID: 'app-001',
      KD_APP_SECRET: 'good-secret',
      KD_USERNAME: 'tester',
    };
    const r = await runCli(['config', 'test', '--profile', 'ci-profile'], env);
    expect(r.code).toBe(0);
  });

  it('config init --interactive：管道喡答案生成可直接使用的配置（app 分支 + 默认值 + 补尾斜杠）', async () => {
    const stdin = [
      'dev',                        // profile 名
      'http://your-server:8080/k3cloud', // server-url（无尾斜杠，应自动补）
      'acct-001',
      'app',
      'tester',
      'app-001',
      'good-secret',
      '',                           // lcid 默认 2052
      '',                           // mode 默认 readwrite
    ].join('\n') + '\n';
    const r = await runCli(['config', 'init', '--interactive'], baseEnv(), stdin);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.hint).toContain('config test');
    // 生成的文件立即可用：config list 通过，且 default-profile 就绪
    const list = await runCli(['config', 'list'], baseEnv());
    expect(list.code).toBe(0);
    expect(list.json.data.profiles[0]).toMatchObject({
      name: 'dev',
      auth: 'app',
      'app-id': 'app-001',
      'app-secret': '******',
      default: true,
    });
  });

  it('config init --interactive password 分支 + 非 TTY 默认仍为模板', async () => {
    const stdin = [
      'dev',
      'http://your-server:8080/k3cloud/',
      'acct-001',
      'password',
      'user1',
      'pass1',
      '',
      '',
    ].join('\n') + '\n';
    const r = await runCli(['config', 'init', '--interactive', '--force'], baseEnv(), stdin);
    expect(r.code).toBe(0);
    const list = await runCli(['config', 'list'], baseEnv());
    expect(list.json.data.profiles[0]).toMatchObject({ auth: 'password', password: '******' });

    // 非 TTY 不带 --interactive：保持模板行为（agent/CI 兼容）
    const tpl = await runCli(['config', 'init', '--force'], baseEnv());
    expect(tpl.code).toBe(0);
    const list2 = await runCli(['config', 'list'], baseEnv());
    expect(list2.json.data.profiles[0]['app-secret']).toBe('******');
    expect(list2.json.data.profiles[0]).toMatchObject({ name: 'dev', auth: 'app' });
  });

  it('配置文件已存在且未带 --force：向导不启动，立即报错（不消耗 stdin 答案）', async () => {
    await writeConfig();
    // 若预检缺失，向导会消费这些答案后最后才报错——答案喂不存在的多余行也无妨
    const r = await runCli(['config', 'init', '--interactive'], baseEnv(), 'dev\n');
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('配置文件已存在');
    expect(r.json.error.message).toContain('--force');
  });

  it('config init 创建配置文件且退出码 0，重复创建失败退出码 2，--force 覆盖', async () => {
    const first = await runCli(['config', 'init'], baseEnv());
    expect(first.code).toBe(0);
    expect(first.json.ok).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'config.yaml'))).toBe(true);

    const duplicate = await runCli(['config', 'init'], baseEnv());
    expect(duplicate.code).toBe(2);
    expect(duplicate.json.error.code).toBe(2);

    const forced = await runCli(['config', 'init', '--force'], baseEnv());
    expect(forced.code).toBe(0);
  });

  it('config list 列出 profile 且凭据脱敏', async () => {
    await writeConfig({ password: 'plain-secret' });
    const r = await runCli(['config', 'list'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.profiles[0].name).toBe('dev');
    expect(r.json.data.profiles[0].password).toBe('******');
    expect(r.json.data.profiles[0]['app-secret']).toBe('******');
    expect(r.stdout).not.toContain('plain-secret');
    expect(r.stdout).not.toContain('good-secret');
  });

  it('config test app 认证成功：exit 0，走 LoginByAppSecret 端点，输出 profile 信息', async () => {
    await writeConfig();
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.auth).toBe('app');
    expect(r.json.data.profile).toBe('dev');
    expect(stub.requests).toHaveLength(1);
    // 回归：URL 拼接不得出现双重 /k3cloud/K3Cloud/ 路径
    expect(stub.requests[0].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret',
    );
    // app 认证参数顺序：[acctId, username, appId, appSecret, lcid]
    expect(stub.requests[0].body).toEqual([
      'acct-001',
      'tester',
      'app-001',
      'good-secret',
      2052,
    ]);
    // T7 校准：真实 kdsvc 要求 JSON 信封，裸数组被 500 拒绝（stub 已同步此语义）
    expect(stub.requests[0].envelope).toMatchObject({
      format: 1,
      useragent: 'ApiClient',
      v: '1.0',
    });
    expect(typeof stub.requests[0].envelope?.rid).toBe('string');
    expect(stub.requests[0].envelope?.parameters).toEqual(stub.requests[0].body);
  });

  it('config test password 认证成功：走 ValidateUser 端点', async () => {
    await writeConfig({
      auth: 'password',
      'app-id': undefined,
      'app-secret': undefined,
      password: 'good',
    });
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.auth).toBe('password');
    expect(stub.requests[0].service).toContain('ValidateUser');
  });

  it('错误凭据：exit 3 且诊断信息可操作', async () => {
    await writeConfig({ 'app-secret': 'wrong-secret' });
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(3);
    expect(r.json.error.code).toBe(3);
    expect(r.json.error.message).toContain('登录失败');
    expect(r.json.error.hints.length).toBeGreaterThan(0);
  });

  it('金蝶返回误导性的「会话信息已丢失」时翻译为可操作诊断', async () => {
    await writeConfig();
    stub.loginResultType = -1;
    stub.loginMessage = '会话信息已丢失，请重新登录';
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(3);
    // 翻译后应指向真正的根因排查方向（账套/授权配置），而非让人重新登录
    const hints = r.json.error.hints.join('\n');
    expect(hints).toContain('acct-id');
    expect(hints).toContain('授权');
  });

  it('KD_ 环境变量覆盖配置文件字段', async () => {
    // 配置文件故意指向不可达地址
    await writeConfig({ 'server-url': 'http://127.0.0.1:1/k3cloud/' });
    const r = await runCli(['config', 'test'], {
      ...baseEnv(),
      KD_SERVER_URL: stub.url,
    });
    expect(r.code).toBe(0);
    expect(r.json.data['server-url']).toBe(stub.url);
  });

  it('网络不可达：exit 5', async () => {
    await writeConfig({ 'server-url': 'http://127.0.0.1:1/k3cloud/' });
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(5);
    expect(r.json.error.code).toBe(5);
  });

  it('配置无效（缺少必填字段）：exit 2 且列出缺失项', async () => {
    await writeConfig({ 'app-secret': undefined });
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('app-secret');
  });

  it('未知 --mode：exit 2', async () => {
    await writeConfig();
    const r = await runCli(['config', 'test', '--mode', 'warp'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('--mode');
  });

  it('未知命令：仍遵守 stdout JSON 契约，exit 2', async () => {
    const r = await runCli(['bogus'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe(2);
  });

  it('非 JSON 响应（网关拦截/错误站点）：exit 5 且携带诊断载荷（content-type + body 前缀）', async () => {
    await writeConfig();
    stub.rawBody = '<html>502 Bad Gateway</html>';
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(5);
    expect(r.json.error.message).toContain('无法解析的响应');
    expect(r.json.error.hints.join('\n')).toContain('server-url');
    // 校准反馈：HTTP 200 + HTML 时需能一眼区分"错误页"与"协议不符"
    expect(r.json.data['content-type']).toContain('application/json');
    expect(r.json.data['body-prefix']).toContain('<html>');
  });

  it('响应非登录协议对象（合法 JSON 但形状不对）：exit 5', async () => {
    await writeConfig();
    stub.rawBody = '[]';
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(5);
  });

  it('畸形配置文件（空内容）：exit 2 且诊断可操作', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), '', 'utf8');
    const r = await runCli(['config', 'test'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('配置文件格式无效');
  });

  it('--pretty 输出缩进 JSON', async () => {
    await writeConfig();
    const r = await runCli(['config', 'test', '--pretty'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('\n  ');
  });

  it('--profile 选择指定 profile', async () => {
    const config = {
      'default-profile': 'dev',
      profiles: {
        dev: {
          'server-url': 'http://127.0.0.1:1/k3cloud/',
          'acct-id': 'a',
          auth: 'app',
          username: 'u',
          'app-id': 'i',
          'app-secret': 'good-secret',
        },
        prod: {
          'server-url': stub.url,
          'acct-id': 'acct-prod',
          auth: 'app',
          username: 'tester',
          'app-id': 'app-001',
          'app-secret': 'good-secret',
        },
      },
    };
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      stringify(config),
      'utf8',
    );
    const r = await runCli(['config', 'test', '--profile', 'prod'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.profile).toBe('prod');
    expect(r.json.data['acct-id']).toBe('acct-prod');
  });
});

describe('CLI 进程边界：查询原语（T2）', () => {
  it('query 用别名解析 formId，请求形态精确匹配，携带会话 Cookie，返回二维数组', async () => {
    await writeConfig();
    const r = await runCli(
      [
        'query',
        '--form', 'sales-order',
        '--fields', 'FID,FBillNo',
        '--filter', "FBillNo = 'XSDD0001'",
        '--limit', '10',
        '--start', '20',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.formId).toBe('SAL_SaleOrder');
    expect(r.json.data.fieldKeys).toEqual(['FID', 'FBillNo']);
    expect(r.json.data.rows).toEqual([
      [100001, 'XSDD0001'],
      [100002, 'XSDD0002'],
    ]);

    // 回归（防 stub 宽松解析洗白 bug）：完整请求形态精确断言
    expect(stub.requests).toHaveLength(2);
    const [loginReq, queryReq] = stub.requests;
    expect(loginReq.service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret',
    );
    expect(queryReq.service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery',
    );
    expect(queryReq.body).toEqual([
      {
        FormId: 'SAL_SaleOrder',
        FieldKeys: 'FID,FBillNo',
        FilterString: "FBillNo = 'XSDD0001'",
        Limit: 10,
        StartRow: 20,
      },
    ]);
    // 登录获得的会话 Cookie 必须随业务请求转发
    expect(queryReq.headers.cookie).toContain('kdservice-sessionid=stub-session');
  });

  it('query 默认 fields=FID、limit=100、start=0；未传 filter/order 时不下发', async () => {
    await writeConfig();
    const r = await runCli(['query', '--form', 'SAL_SaleOrder'], baseEnv());
    expect(r.code).toBe(0);
    expect(stub.requests[1].body).toEqual([
      { FormId: 'SAL_SaleOrder', FieldKeys: 'FID', Limit: 100, StartRow: 0 },
    ]);
  });

  it('query-json 把二维数组 zip 成对象数组', async () => {
    await writeConfig();
    const r = await runCli(
      ['query-json', '--form', 'ar-receivable', '--fields', 'FID,FBillNo'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.formId).toBe('AR_receivable');
    expect(r.json.data.rows).toEqual([
      { FID: 100001, FBillNo: 'XSDD0001' },
      { FID: 100002, FBillNo: 'XSDD0002' },
    ]);
  });

  it('未知别名透传给金蝶，并在 stderr 提示（stdout 保持纯 JSON）', async () => {
    await writeConfig();
    const r = await runCli(['query', '--form', 'PUR_PurchaseOrder'], baseEnv());
    expect(r.code).toBe(0);
    expect((stub.requests[1].body as unknown[])[0]).toMatchObject({
      FormId: 'PUR_PurchaseOrder',
    });
    expect(r.stderr).toContain('不在别名表中');
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it('view --number 走 View 端点，参数为 [formId, pkJSON]', async () => {
    await writeConfig();
    const r = await runCli(['view', '--form', 'sal-outstock', '--number', 'XSCK0001'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.Number).toBe('XSDD0001'); // stub 剧本载荷
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.View',
    );
    expect(stub.requests[1].body).toEqual([
      'SAL_OUTSTOCK',
      JSON.stringify({ Number: 'XSCK0001' }),
    ]);
  });

  it('view 缺少 --id/--number：exit 2', async () => {
    await writeConfig();
    const r = await runCli(['view', '--form', 'sales-order'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('--id');
  });

  it('metadata 用别名（inventory）走 QueryBusinessInfo，参数为 [{FormId}]', async () => {
    await writeConfig();
    const r = await runCli(['metadata', '--form', 'inventory'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.BusinessInfo.Header.TableName).toBe('T_SAL_ORDER');
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.QueryBusinessInfo',
    );
    expect(stub.requests[1].body).toEqual([{ FormId: 'STK_Inventory' }]);
  });

  it('金蝶业务拒绝（如过滤条件非法）：exit 4 且带原始错误信息', async () => {
    await writeConfig();
    stub.businessErrors = ["列名 'FBillNoX' 无效"];
    const r = await runCli(['query', '--form', 'sales-order'], baseEnv());
    expect(r.code).toBe(4);
    expect(r.json.error.code).toBe(4);
    expect(r.json.error.message).toContain("列名 'FBillNoX' 无效");
    expect(r.json.error.hints.join('\n')).toContain('kd metadata');
  });

  it('aliases 列出别名表，含中台常用单据', async () => {
    const r = await runCli(['aliases'], baseEnv());
    expect(r.code).toBe(0);
    const rows = r.json.data as { alias: string; formId: string; label: string }[];
    expect(rows.map((x) => x.alias)).toContain('sales-order');
    expect(rows.map((x) => x.alias)).toContain('inventory');
    expect(rows.find((x) => x.alias === 'inventory')?.formId).toBe('STK_Inventory');
  });

  it('readonly 模式下查询原语可用（读命令不受写闸门限制）', async () => {
    await writeConfig({ mode: 'readonly' });
    const r = await runCli(['query', '--form', 'sales-order'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
  });

  it('金蝶返回空 Result（如无效 formId）：exit 4 而非伪装成功', async () => {
    await writeConfig();
    // 信封存在但 Result 为 null：assertBusinessSuccess 放行，extractBusinessResult 必须拦下
    stub.viewResponse = { Result: null };
    const r = await runCli(['view', '--form', 'sales-order', '--id', '999'], baseEnv());
    expect(r.code).toBe(4);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.message).toContain('空 Result');
  });

  it('view 同时传 --id 与 --number：exit 2', async () => {
    await writeConfig();
    const r = await runCli(
      ['view', '--form', 'sales-order', '--id', '1', '--number', 'XSDD0001'],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('二选一');
  });

  it('fields 带空格/空段时净化后下发，与 query-json 的 zip 键恒等', async () => {
    await writeConfig();
    const r = await runCli(
      ['query-json', '--form', 'sales-order', '--fields', 'FID, FBillNo,'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(stub.requests[1].body).toEqual([
      { FormId: 'SAL_SaleOrder', FieldKeys: 'FID,FBillNo', Limit: 100, StartRow: 0 },
    ]);
    expect(r.json.data.fieldKeys).toEqual(['FID', 'FBillNo']);
  });
});

describe('CLI 进程边界：写入原语与安全闸门（T4）', () => {
  it('readonly profile 下写命令物理拒绝：exit 6 且零网络请求', async () => {
    await writeConfig({ mode: 'readonly' });
    const r = await runCli(['delete', '--form', 'sales-order', '--ids', '100001'], baseEnv());
    expect(r.code).toBe(6);
    expect(r.json.error.code).toBe(6);
    expect(stub.requests).toHaveLength(0);
  });

  it('--mode readonly 全局覆盖同样拒绝写命令：exit 6', async () => {
    await writeConfig(); // profile 是 readwrite
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--ids', '100001', '--mode', 'readonly'],
      baseEnv(),
    );
    expect(r.code).toBe(6);
  });

  it('delete 非 TTY 未带 --yes：dry-run 输出影响面，零网络请求（--ids 直接选择）', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--ids', '100001,100002'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.dryRun).toBe(true);
    expect(r.json.data.formId).toBe('SAL_SaleOrder');
    expect(r.json.data.affected).toEqual([
      { id: '100001', number: null },
      { id: '100002', number: null },
    ]);
    expect(r.json.data.wouldSend).toEqual({ Ids: '100001,100002' });
    expect(stub.requests).toHaveLength(0);
  });

  it('delete --filter 未带 --yes：先解析影响面（查询请求），不发起 Delete', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--filter', "FBillNo like 'XSDD%'"],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.dryRun).toBe(true);
    expect(r.json.data.affected).toEqual([
      { id: '100001', number: 'XSDD0001' },
      { id: '100002', number: 'XSDD0002' },
    ]);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery',
    );
    expect(stub.requests.every((req) => !req.service.includes('Delete'))).toBe(true);
  });

  it('delete --yes --ids：真正发起 Delete，端点与载荷精确匹配', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--ids', '100001,100002', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.ResponseStatus.IsSuccess).toBe(true);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Delete',
    );
    expect(stub.requests[1].body).toEqual(['SAL_SaleOrder', JSON.stringify({ Ids: '100001,100002' })]);
  });

  it('unaudit --yes --numbers：走 UnAudit 端点，载荷为 Numbers', async () => {
    await writeConfig();
    const r = await runCli(
      ['unaudit', '--form', 'sal-outstock', '--numbers', 'XSCK0001,XSCK0002', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.UnAudit',
    );
    expect(stub.requests[1].body).toEqual([
      'SAL_OUTSTOCK',
      JSON.stringify({ Numbers: ['XSCK0001', 'XSCK0002'] }),
    ]);
  });

  it('submit --numbers 成功：exit 0，输出金蝶响应', async () => {
    await writeConfig();
    const r = await runCli(
      ['submit', '--form', 'sales-order', '--numbers', 'XSDD0001'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.ResponseStatus.SuccessEntitys[0].Number).toBe('XSDD0001');
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Submit',
    );
  });

  it('save --data 成功：走 Save 端点，data 原样透传', async () => {
    await writeConfig();
    const bill = { Model: { FBillNo: 'XSDD0009', FDate: '2026-09-25' } };
    const r = await runCli(
      ['save', '--form', 'sales-order', '--data', JSON.stringify(bill)],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.ResponseStatus.IsSuccess).toBe(true);
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Save',
    );
    expect(stub.requests[1].body).toEqual(['SAL_SaleOrder', JSON.stringify(bill)]);
  });

  it('save --data 非法 JSON 或非对象：exit 2 且不发起请求', async () => {
    await writeConfig();
    const r1 = await runCli(['save', '--form', 'sales-order', '--data', 'not-json'], baseEnv());
    expect(r1.code).toBe(2);
    const r2 = await runCli(['save', '--form', 'sales-order', '--data', '[1,2]'], baseEnv());
    expect(r2.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('execute-operation --op Forbid：走 ExecuteOperation，参数为 [formId, op, pkJSON]', async () => {
    await writeConfig();
    const r = await runCli(
      ['execute-operation', '--form', 'sales-order', '--op', 'Forbid', '--ids', '100001'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteOperation',
    );
    expect(stub.requests[1].body).toEqual([
      'SAL_SaleOrder',
      'Forbid',
      JSON.stringify({ Ids: '100001' }),
    ]);
  });

  it('push --target-form：载荷含 Ids/TargetFormId/TargetOrgId，目标别名同样解析', async () => {
    await writeConfig();
    const r = await runCli(
      [
        'push',
        '--form', 'sales-order',
        '--target-form', 'ar-receivable',
        '--ids', '100001',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(stub.requests[1].service).toBe(
      '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Push',
    );
    expect(stub.requests[1].body).toEqual([
      'SAL_SaleOrder',
      JSON.stringify({ Ids: '100001', TargetFormId: 'AR_receivable', TargetOrgId: 0 }),
    ]);
  });

  it('批量熔断：--ids 数量超过 --max-count → exit 7，零请求', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--ids', '1,2,3', '--max-count', '2'],
      baseEnv(),
    );
    expect(r.code).toBe(7);
    expect(r.json.error.code).toBe(7);
    expect(r.json.error.message).toContain('超过批量上限 2');
    expect(stub.requests).toHaveLength(0);
  });

  it('filter 命中数超过上限：查询 Limit 为 maxCount+1，熔断 exit 7', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--filter', 'FDocumentStatus=C', '--max-count', '1'],
      baseEnv(),
    );
    expect(r.code).toBe(7);
    expect(stub.requests[1].body).toEqual([
      {
        FormId: 'SAL_SaleOrder',
        FieldKeys: 'FID,FBillNo',
        FilterString: 'FDocumentStatus=C',
        Limit: 2,
        StartRow: 0,
      },
    ]);
  });

  it('金蝶拒绝写操作：exit 4 且诊断保留原始错误', async () => {
    await writeConfig();
    stub.businessErrors = ['单据已被反审核，不能再次反审核'];
    const r = await runCli(
      ['unaudit', '--form', 'sales-order', '--ids', '100001', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(4);
    expect(r.json.error.message).toContain('不能再次反审核');
  });

  it('filter 未命中任何单据：exit 2', async () => {
    await writeConfig();
    stub.queryRows = [];
    const r = await runCli(
      ['delete', '--form', 'sales-order', '--filter', 'FBillNo=NONE', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('未命中任何单据');
  });

  it('--ids 与 --numbers 同时传入：违反三选一契约，exit 2', async () => {
    await writeConfig();
    const r = await runCli(
      ['submit', '--form', 'sales-order', '--ids', '100001', '--numbers', 'XSDD0001'],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('三选一');
    expect(stub.requests).toHaveLength(0);
  });

  it('子命令未知选项：commander 的 process.exit(1) 不再绕过 JSON 契约，exit 2', async () => {
    await writeConfig();
    const r = await runCli(['submit', '--form', 'sales-order', '--bogus'], baseEnv());
    expect(r.code).toBe(2);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe(2);
  });
});

describe('CLI 进程边界：delete-chain 复合命令（T5）', () => {
  const EXPECTED_QUERY = (formId: string) => [
    {
      FormId: formId,
      FieldKeys: 'FID,FBillNo',
      FilterString: "FTraceId='ST-202609-0001'",
      Limit: 51,
      StartRow: 0,
    },
  ];

  it('默认 dry-run：全链反查（AR→OUT→SO 顺序）、输出影响面，不发起任何写请求', async () => {
    await writeConfig();
    const r = await runCli(['delete-chain', '--trace-id', 'ST-202609-0001'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.dryRun).toBe(true);
    expect(r.json.data.chain).toBe('month-end');
    expect(r.json.data.steps).toHaveLength(3);
    expect(r.json.data.steps[0]).toMatchObject({ form: 'ar-receivable', formId: 'AR_receivable' });
    expect(r.json.data.steps[0].refs).toEqual([
      { id: '100001', number: 'XSDD0001' },
      { id: '100002', number: 'XSDD0002' },
    ]);

    // 4 请求 = 1 登录 + 3 反查；无任何写请求
    expect(stub.requests).toHaveLength(4);
    expect(stub.requests.slice(1).map((q) => (q.body as unknown[])[0])).toEqual([
      EXPECTED_QUERY('AR_receivable')[0],
      EXPECTED_QUERY('SAL_OUTSTOCK')[0],
      EXPECTED_QUERY('SAL_SaleOrder')[0],
    ]);
    expect(stub.requests.every((q) => !q.service.includes('UnAudit'))).toBe(true);
    expect(stub.requests.every((q) => !q.service.includes('Delete'))).toBe(true);
  });

  it('--yes 全链存在：逆下推方向逐环节反审核+删除，报告逐环节成功', async () => {
    await writeConfig();
    const r = await runCli(['delete-chain', '--trace-id', 'ST-202609-0001', '--yes'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.steps).toHaveLength(3);
    for (const step of r.json.data.steps) {
      expect(step.unaudit).toEqual({ ok: true });
      expect(step.delete).toEqual({ ok: true });
    }

    // 10 请求 = 1 登录 + 3 反查（索引 1-3）+ 3×(UnAudit+Delete)，顺序 AR→OUT→SO
    expect(stub.requests).toHaveLength(10);
    const services = stub.requests.slice(4).map((q) => q.service.split('.').pop()!);
    expect(services).toEqual([
      'UnAudit', 'Delete', // AR_receivable
      'UnAudit', 'Delete', // SAL_OUTSTOCK
      'UnAudit', 'Delete', // SAL_SaleOrder
    ]);
    expect(stub.requests[4].body).toEqual(['AR_receivable', JSON.stringify({ Ids: '100001,100002' })]);
    expect(stub.requests[6].body).toEqual(['SAL_OUTSTOCK', JSON.stringify({ Ids: '100001,100002' })]);
    expect(stub.requests[8].body).toEqual(['SAL_SaleOrder', JSON.stringify({ Ids: '100001,100002' })]);
  });

  it('应收单未下推（未命中）：降级跳过，仅删除出库单+销售订单，正常完成', async () => {
    await writeConfig();
    stub.queryRowsByForm = { AR_receivable: [] };
    const r = await runCli(['delete-chain', '--trace-id', 'ST-202609-0001', '--yes'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.steps[0].skipped).toBe(true);
    expect(r.json.data.steps[1].unaudit).toEqual({ ok: true });
    expect(r.json.data.steps[2].delete).toEqual({ ok: true });
    // 8 请求 = 1 登录 + 3 反查 + 2×(UnAudit+Delete)
    expect(stub.requests).toHaveLength(8);
  });

  it('环节反审核被拒：exit 4，报告标注失败环节，后续环节不执行', async () => {
    await writeConfig();
    stub.writeErrors = ['单据已被锁定，无法反审核'];
    const r = await runCli(['delete-chain', '--trace-id', 'ST-202609-0001', '--yes'], baseEnv());
    expect(r.code).toBe(4);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe(4);
    expect(r.json.error.message).toContain('ar-receivable');
    expect(r.json.error.message).toContain('单据已被锁定');
    expect(r.json.data.steps[0].unaudit).toEqual({ ok: false, error: expect.stringContaining('单据已被锁定') });
    expect(r.json.data.steps[0].delete).toBeUndefined();
    expect(r.json.data.steps[1].unaudit).toBeUndefined();
    // 只有 1 个写请求（AR 反审核），后续全部停止
    expect(stub.requests.filter((q) => q.service.includes('UnAudit') || q.service.includes('Delete'))).toHaveLength(1);
  });

  it('chains.yaml 扩展新链并被 --chain 选用', async () => {
    await writeConfig();
    fs.writeFileSync(
      path.join(configDir, 'chains.yaml'),
      stringify({ chains: { return: { description: '退货链', forms: ['sales-order'] } } }),
      'utf8',
    );
    const r = await runCli(
      ['delete-chain', '--trace-id', 'ST-202609-0001', '--chain', 'return', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.chain).toBe('return');
    expect(r.json.data.steps).toHaveLength(1);
    expect(r.json.data.steps[0].formId).toBe('SAL_SaleOrder');
    // 4 请求 = 1 登录 + 1 反查 + 1×(UnAudit+Delete)
    expect(stub.requests).toHaveLength(4);
  });

  it('追踪字段三级解析：默认 FTraceId < 链配置 traceField < CLI --trace-field', async () => {
    await writeConfig();
    fs.writeFileSync(
      path.join(configDir, 'chains.yaml'),
      stringify({ chains: { return: { description: '退货链', forms: ['sales-order'], traceField: 'FMyTrace' } } }),
      'utf8',
    );
    const querySent = () =>
      (stub.requests[1].body as { FilterString?: string }[])[0]?.FilterString;
    // 无配置：用默认 FTraceId
    await runCli(['delete-chain', '--trace-id', 'T1'], baseEnv());
    expect(querySent()).toBe("FTraceId='T1'");
    // 链配置 traceField
    stub.requests.length = 0;
    await runCli(['delete-chain', '--trace-id', 'T2', '--chain', 'return'], baseEnv());
    expect(querySent()).toBe("FMyTrace='T2'");
    // CLI --trace-field 覆盖一切
    stub.requests.length = 0;
    await runCli(['delete-chain', '--trace-id', 'T3', '--chain', 'return', '--trace-field', 'FCliTrace'], baseEnv());
    expect(querySent()).toBe("FCliTrace='T3'");
  });

  it('未知 --chain：exit 2 且列出可用链条', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete-chain', '--trace-id', 'ST-202609-0001', '--chain', 'bogus', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('month-end');
  });

  it('--max-count 熟断对链条总量生效：exit 7 且无写请求', async () => {
    await writeConfig();
    const r = await runCli(
      ['delete-chain', '--trace-id', 'ST-202609-0001', '--max-count', '5', '--yes'],
      baseEnv(),
    );
    expect(r.code).toBe(7);
    expect(r.json.error.message).toContain('超过批量上限 5');
    expect(stub.requests.every((q) => !q.service.includes('UnAudit'))).toBe(true);
  });

  it('readonly profile：exit 6 且零网络请求', async () => {
    await writeConfig({ mode: 'readonly' });
    const r = await runCli(['delete-chain', '--trace-id', 'ST-202609-0001'], baseEnv());
    expect(r.code).toBe(6);
    expect(stub.requests).toHaveLength(0);
  });

  it('--trace-id 含单引号（注入防御）：exit 2 且零请求', async () => {
    await writeConfig();
    const r = await runCli(["delete-chain", '--trace-id', "ST'OR'1'='1"], baseEnv());
    expect(r.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('全链未命中：--yes 也不执行写操作，提示核对 trace-id', async () => {
    await writeConfig();
    stub.queryRows = [];
    const r = await runCli(['delete-chain', '--trace-id', 'ST-NONE', '--yes'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data.note).toContain('未命中');
    expect(stub.requests.every((q) => !q.service.includes('UnAudit'))).toBe(true);
  });
});

describe('CLI 进程边界：大数据量查询（T3）', () => {
  /** 真实协议语义 stub：返回 rows.slice(StartRow, StartRow+Limit)；返回不足 Limit 即视为拉完 */
  function paginateStub(rows: unknown[][]): void {
    stub.queryFn = (p) => {
      const start = p.StartRow ?? 0;
      return rows.slice(start, start + (p.Limit ?? 2000));
    };
  }

  it('count：跨多页自动翻页计数，StartRow 序列与 Limit 形态精确', async () => {
    await writeConfig();
    // 2001 行 > PAGE_SIZE(2000)：必然翻页（第一页满 2000，第二页 1 行收尾）
    const rows = Array.from({ length: 2001 }, (_, i) => [100001 + i]);
    paginateStub(rows);
    const r = await runCli(['count', '--form', 'sales-order'], baseEnv());
    expect(r.code).toBe(0);
    expect(r.json.data).toEqual({ count: 2001 });
    // 1 登录 + 2 次查询（StartRow 0/2000）
    const queries = stub.requests.filter((q) => q.service.includes('ExecuteBillQuery'));
    expect(queries).toHaveLength(2);
    expect(queries.map((q) => (q.body as unknown[])[0])).toMatchObject([
      { FormId: 'SAL_SaleOrder', FieldKeys: 'FID', Limit: 2000, StartRow: 0 },
      { FieldKeys: 'FID', Limit: 2000, StartRow: 2000 },
    ]);
  });

  it('query-all：多页结果完整合并', async () => {
    await writeConfig();
    const rows = Array.from({ length: 2001 }, (_, i) => [100001 + i, `XSDD${i}`]);
    paginateStub(rows);
    const r = await runCli(
      ['query-all', '--form', 'sales-order', '--fields', 'FID,FBillNo'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.fetched).toBe(2001);
    expect(r.json.data.fieldKeys).toEqual(['FID', 'FBillNo']);
    expect(r.json.data.rows).toEqual(rows);
  });

  it('query-all 达上限：exit 7，data 携带已拉取部分 + truncated 标记（data+error 并存）', async () => {
    await writeConfig();
    const rows = Array.from({ length: 5 }, (_, i) => [100001 + i, `XSDD${i}`]);
    paginateStub(rows);
    const r = await runCli(
      ['query-all', '--form', 'sales-order', '--fields', 'FID,FBillNo', '--max', '4'],
      baseEnv(),
    );
    expect(r.code).toBe(7);
    expect(r.json.error.code).toBe(7);
    expect(r.json.error.message).toContain('安全上限 4');
    expect(r.json.data.truncated).toBe(true);
    expect(r.json.data.rows).toHaveLength(4);
    expect(r.json.data.fetched).toBe(4);
  });

  it('count 达上限：报告 atLeast 而非精确 count', async () => {
    await writeConfig();
    paginateStub([[1], [2], [3]]);
    const r = await runCli(['count', '--form', 'sales-order', '--max', '2'], baseEnv());
    expect(r.code).toBe(7);
    expect(r.json.data).toEqual({ count: null, atLeast: 2 });
  });

  it('query-file ndjson：逐页流式落盘，文件内容可逐行解析', async () => {
    await writeConfig();
    const rows = Array.from({ length: 4 }, (_, i) => [100001 + i, `XSDD${i}`]);
    paginateStub(rows);
    const out = path.join(configDir, 'out.ndjson');
    const r = await runCli(
      [
        'query-file', '--form', 'sales-order', '--fields', 'FID,FBillNo',
        '--out', out, '--format', 'ndjson',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data).toEqual({ file: out, format: 'ndjson', rows: 4 });
    const lines = fs.readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => JSON.parse(l))).toEqual(
      rows.map(([id, no]) => ({ FID: id, FBillNo: no })),
    );
  });

  it('query-file csv：RFC 4180 转义（逗号/双引号/换行）', async () => {
    await writeConfig();
    stub.queryFn = () => [['a,b', 'say "hi"', 'line1\nline2']];
    const out = path.join(configDir, 'out.csv');
    const r = await runCli(
      [
        'query-file', '--form', 'sales-order', '--fields', 'FA,FB,FC',
        '--out', out, '--format', 'csv',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(
      'FA,FB,FC\n"a,b","say ""hi""","line1\nline2"\n',
    );
  });

  it('query-file 达上限：exit 7，文件仍保留已写入部分', async () => {
    await writeConfig();
    paginateStub([[1], [2], [3], [4]]);
    const out = path.join(configDir, 'out.ndjson');
    const r = await runCli(
      ['query-file', '--form', 'sales-order', '--fields', 'FID', '--out', out, '--max', '2'],
      baseEnv(),
    );
    expect(r.code).toBe(7);
    expect(r.json.data).toEqual({ file: out, format: 'ndjson', rows: 2, truncated: true });
    expect(fs.readFileSync(out, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  it('query-range month：跨月分片逐片翻页，FilterString 按片组合', async () => {
    await writeConfig();
    // 按片首月返回行数：1 月片回 1 行，2 月片回 2 行，3 月片回 0 行（尊重 Limit，真实语义）
    stub.queryFn = (p) => {
      const m = /FDate >= '(\d{4}-\d{2})/.exec(p.FilterString ?? '')?.[1];
      const count = m === '2026-01' ? 1 : m === '2026-02' ? 2 : 0;
      return Array.from({ length: Math.min(count - (p.StartRow ?? 0), p.Limit ?? 2000) }, (_, i) => [i]);
    };
    const r = await runCli(
      [
        'query-range', '--form', 'sales-order', '--fields', 'FID',
        '--from', '2026-01-30', '--to', '2026-03-02',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.granularity).toBe('month');
    expect(r.json.data.total).toBe(3);
    expect(r.json.data.ranges.map((s: any) => [s.from, s.to, s.count])).toEqual([
      ['2026-01-30', '2026-01-31', 1],
      ['2026-02-01', '2026-02-28', 2],
      ['2026-03-01', '2026-03-02', 0],
    ]);
    const queries = stub.requests.filter((q) => q.service.includes('ExecuteBillQuery'));
    // 1 登录 + 3 片各 1 页（片内行数 < Limit 直接收尾）
    expect(queries).toHaveLength(3);
    expect((queries[0].body as unknown[])[0]).toMatchObject({
      FormId: 'SAL_SaleOrder',
      FilterString: "(FDate >= '2026-01-30' and FDate <= '2026-01-31')",
      Limit: 2000,
      StartRow: 0,
    });
  });

  it('query-range 达上限：exit 7，报告 truncatedRange 与已完成分片', async () => {
    await writeConfig();
    stub.queryFn = (p) => [[1], [2]].slice(0, p.Limit ?? 2);
    const r = await runCli(
      [
        'query-range', '--form', 'sales-order', '--fields', 'FID',
        '--from', '2026-01-01', '--to', '2026-01-31', '--max', '1',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(7);
    expect(r.json.data.truncatedRange).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(r.json.data.total).toBe(1);
  });

  it('query-range 非法粒度：exit 2', async () => {
    await writeConfig();
    const r = await runCli(
      [
        'query-range', '--form', 'sales-order', '--fields', 'FID',
        '--from', '2026-01-01', '--to', '2026-01-31', '--granularity', 'year',
      ],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('month | week | day');
  });

  it('--max 非法值：exit 2', async () => {
    await writeConfig();
    const r = await runCli(
      ['count', '--form', 'sales-order', '--max', 'abc'],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain('--max');
  });

  it('query-file --out 路径无效：流错误进 await 链，exit 2 且 stdout 仍有 JSON', async () => {
    await writeConfig();
    const out = path.join(configDir, 'no-such-dir', 'out.ndjson');
    const r = await runCli(
      ['query-file', '--form', 'sales-order', '--fields', 'FID', '--out', out],
      baseEnv(),
    );
    expect(r.code).toBe(2);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBeDefined();
  });

  it('数据集恰好等于 --max：不误报 truncated，exit 0', async () => {
    await writeConfig();
    const rows = Array.from({ length: 4 }, (_, i) => [100001 + i]);
    paginateStub(rows);
    const r = await runCli(
      ['query-all', '--form', 'sales-order', '--fields', 'FID', '--max', '4'],
      baseEnv(),
    );
    expect(r.code).toBe(0);
    expect(r.json.data.fetched).toBe(4);
    expect(r.json.data.truncated).toBeUndefined();
  });
});

describe('splitDateRange 纯函数：日期分片边界', () => {
  it('month：月末边界与跨年', () => {
    expect(splitDateRange('2026-01-30', '2026-03-02', 'month')).toEqual([
      { from: '2026-01-30', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-03-02' },
    ]);
    expect(splitDateRange('2025-12-15', '2026-01-20', 'month')).toEqual([
      { from: '2025-12-15', to: '2025-12-31' },
      { from: '2026-01-01', to: '2026-01-20' },
    ]);
    // 闰年 2 月
    expect(splitDateRange('2024-02-01', '2024-03-01', 'month')).toEqual([
      { from: '2024-02-01', to: '2024-02-29' },
      { from: '2024-03-01', to: '2024-03-01' },
    ]);
  });

  it('week：从 from 起每 7 天一片', () => {
    expect(splitDateRange('2026-01-01', '2026-01-14', 'week')).toEqual([
      { from: '2026-01-01', to: '2026-01-07' },
      { from: '2026-01-08', to: '2026-01-14' },
    ]);
  });

  it('day：每日一片；from > to 与非法粒度抛错', () => {
    expect(splitDateRange('2026-09-30', '2026-10-01', 'day')).toEqual([
      { from: '2026-09-30', to: '2026-09-30' },
      { from: '2026-10-01', to: '2026-10-01' },
    ]);
    expect(() => splitDateRange('2026-02-01', '2026-01-01', 'month')).toThrow();
    expect(() => splitDateRange('2026-01-01', '2026-01-31', 'year' as never)).toThrow();
  });
});
