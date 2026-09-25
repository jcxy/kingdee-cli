import { randomUUID } from 'node:crypto';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import type { Profile } from './config.js';

/** kdsvc 业务层错误：携带退出码与可操作诊断 */
export class KdsvcError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly hints?: string[],
    /** 失败时仍值得输出的部分成果（如达上限时已拉取的数据），随 error 一并 emit */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** 登录响应（K3Cloud AuthService） */
export interface LoginResult {
  LoginResultType: number;
  Message?: string | null;
  Context?: unknown;
  MessageCode?: number;
}

/** 构造 kdsvc 端点 URL：server-url 以 /k3cloud/ 结尾，后直接拼服务名 */
export function kdsvcUrl(serverUrl: string, service: string): string {
  return `${serverUrl}${service}.common.kdsvc`;
}

/**
 * 构造 kdsvc 统一请求信封（T7 真实环境校准发现：端点要求 JSON 对象信封，
 * 裸参数数组会被服务端以 "Additional text found in JSON string" 500 拒绝。
 * 已在真实 dev 环境验证：envelope 格式返回标准登录信封）。
 */
export function buildEnvelope(parameters: unknown[]): Record<string, unknown> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return {
    format: 1,
    useragent: 'ApiClient',
    rid: randomUUID(),
    parameters,
    timestamp,
    v: '1.0',
  };
}

export const AUTH_SERVICE = {
  validateUser: 'Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser',
  loginByAppSecret: 'Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret',
} as const;

export const DYNAMIC_FORM_SERVICE = {
  executeBillQuery:
    'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery',
  view: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.View',
  queryBusinessInfo:
    'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.QueryBusinessInfo',
  save: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Save',
  submit: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Submit',
  audit: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Audit',
  unAudit: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.UnAudit',
  delete: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Delete',
  executeOperation:
    'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteOperation',
  push: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Push',
} as const;

/** ExecuteBillQuery 的查询参数对象 */
export interface BillQueryParams {
  FormId: string;
  /** 逗号分隔的字段 key 集合 */
  FieldKeys: string;
  FilterString?: string;
  OrderString?: string;
  TopRowCount?: number;
  StartRow?: number;
  Limit?: number;
}

/** 金蝶业务响应统一信封（View/QueryBusinessInfo 成功体、查询失败体共用） */
export interface KdsvcBusinessResult {
  Result?: {
    ResponseStatus?: {
      IsSuccess?: boolean;
      Errors?: { Message?: string; FieldName?: string }[];
      SuccessEntitys?: { Id?: string; Number?: string }[];
    };
  } & Record<string, unknown>;
}

/** 每次命令执行即登即用（无状态），成功返回会话 Cookie */
export async function login(profile: Profile): Promise<string> {
  const body =
    profile.auth === 'app'
      ? [profile['acct-id'], profile.username, profile['app-id'], profile['app-secret'], profile.lcid]
      : [profile['acct-id'], profile.username, profile.password, profile.lcid];
  const service =
    profile.auth === 'app' ? AUTH_SERVICE.loginByAppSecret : AUTH_SERVICE.validateUser;

  let res: Response;
  try {
    res = await fetch(kdsvcUrl(profile['server-url'], service), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildEnvelope(body)),
      // 薄封装的动机之一：完全可控的超时，避免挂到 undici 默认的 5 分钟
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      throw new KdsvcError(
        EXIT_CODES.NETWORK_ERROR,
        `金蝶服务器 30 秒内未响应: ${profile['server-url']}`,
        ['检查内网连通性（是否需要 VPN）', '用浏览器打开 server-url 确认可达'],
      );
    }
    throw new KdsvcError(
      EXIT_CODES.NETWORK_ERROR,
      `无法连接金蝶服务器: ${profile['server-url']}（${cause.message}）`,
      [
        '用 kd config test 检查连通性',
        '确认 server-url 以 /k3cloud/ 形式结尾且服务器可达（内网环境需 VPN）',
      ],
    );
  }

  if (!res.ok) {
    throw new KdsvcError(
      EXIT_CODES.NETWORK_ERROR,
      `金蝶服务器返回 HTTP ${res.status} ${res.statusText}`,
      ['确认 server-url 指向 K3Cloud 站点根（以 / 结尾）'],
    );
  }

  let raw: LoginResult;
  let loginText = '';
  try {
    // 先取文本再解析：JSON.parse 失败时保留原文片段用于诊断（校准发现：
    // 打到站点根返回 200 HTML 时，旧报错无法区分"HTML 页"与"协议不符"）
    loginText = await res.text();
    raw = JSON.parse(loginText) as LoginResult;
    if (
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      typeof raw.LoginResultType !== 'number'
    ) {
      throw new Error('响应不符合 kdsvc 登录协议');
    }
  } catch {
    throw new KdsvcError(
      EXIT_CODES.NETWORK_ERROR,
      '金蝶服务器返回了无法解析的响应（server-url 可能未指向 K3Cloud 站点，或被网关/反向代理拦截）',
      ['用浏览器打开 server-url，确认返回的是 K3Cloud 站点而非错误页'],
      {
        'content-type': res.headers.get('content-type') ?? '(无)',
        'body-prefix': loginText.slice(0, 120),
      },
    );
  }

  assertLoginSuccess(raw);

  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

/** 登录后携带会话 Cookie 调用任意 kdsvc 服务，返回解析后的 JSON。
 * 传入 cookie（已持有会话）时不再重复登录——复合命令全程只登一次。 */
export async function callService(
  profile: Profile,
  service: string,
  params: unknown[],
  cookie?: string,
): Promise<unknown> {
  const session = cookie ?? (await login(profile));

  let res: Response;
  try {
    res = await fetch(kdsvcUrl(profile['server-url'], service), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session,
      },
      body: JSON.stringify(buildEnvelope(params)),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      throw new KdsvcError(
        EXIT_CODES.NETWORK_ERROR,
        `金蝶服务器 30 秒内未响应: ${profile['server-url']}`,
        ['检查内网连通性（是否需要 VPN）'],
      );
    }
    throw new KdsvcError(
      EXIT_CODES.NETWORK_ERROR,
      `调用 ${service} 时连接失败: ${cause.message}`,
      ['用 kd config test 检查连通性'],
    );
  }

  if (!res.ok) {
    throw new KdsvcError(
      EXIT_CODES.NETWORK_ERROR,
      `金蝶服务器返回 HTTP ${res.status} ${res.statusText}（${service}）`,
      ['会话可能已过期，重试一次；持续出现则检查服务名拼写'],
    );
  }

  try {
    return await res.json();
  } catch {
    throw new KdsvcError(
      EXIT_CODES.NETWORK_ERROR,
      `金蝶服务器对 ${service} 返回了无法解析的响应`,
      ['重试一次；持续出现则确认 server-url 指向 K3Cloud 站点'],
    );
  }
}

/**
 * 把金蝶业务响应信封翻译为 KdsvcError(KINGDEE_REJECTED)。
 * ExecuteBillQuery 成功返回二维数组（无信封），失败才有 Result.ResponseStatus。
 */
export function assertBusinessSuccess(raw: unknown, context: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const status = (raw as KdsvcBusinessResult).Result?.ResponseStatus;
  if (!status || status.IsSuccess !== false) return;

  const errors = (status.Errors ?? [])
    .map((e) => e.Message || JSON.stringify(e))
    .filter(Boolean);
  const message = errors.length ? errors.join('; ') : '金蝶未返回具体错误信息';
  throw new KdsvcError(
    EXIT_CODES.KINGDEE_REJECTED,
    `金蝶拒绝了${context}: ${message}`,
    ['过滤条件语法参考: FBillNo = \'XSDD0001\'（字段名可用 kd metadata 核对）'],
  );
}

/** 提取业务响应的 Result 载荷；空 Result 视为金蝶侧失败（表单不存在/被拦截），不能伪装成成功 */
export function extractBusinessResult(raw: unknown, context: string): unknown {
  assertBusinessSuccess(raw, context);
  if (raw === null || typeof raw !== 'object' || (raw as KdsvcBusinessResult).Result == null) {
    throw new KdsvcError(
      EXIT_CODES.KINGDEE_REJECTED,
      `金蝶对${context}返回了空 Result（表单可能不存在或服务被拦截）`,
      ['用 kd aliases 确认 formId 拼写；直接传 formId 时注意大小写'],
    );
  }
  return (raw as KdsvcBusinessResult).Result;
}

/** 把金蝶登录失败翻译为可操作诊断，而不是原始误导文案 */
export function assertLoginSuccess(raw: LoginResult): void {
  if (raw.LoginResultType === 1) return;

  const message = raw.Message || '';
  const hints: string[] = [];
  if (message.includes('会话信息已丢失')) {
    hints.push('该报文通常意味着凭据或授权配置错误，而非真的会话丢失');
    hints.push('检查 acct-id（账套 ID）是否正确：金蝶管理端「生成测试链接」弹窗可查看');
    hints.push('auth=app 时：确认第三方系统登录授权中应用已启用、集成用户已指定、白名单包含本机 IP');
  } else if (message.includes('密码')) {
    hints.push('检查 username/password（KD_USERNAME / KD_PASSWORD）');
  } else {
    hints.push('auth=app 时检查 app-id / app-secret（KD_APP_ID / KD_APP_SECRET）');
    hints.push('auth=password 时检查用户名密码；集成用户需开通 API 访问权限');
  }
  hints.push('配置来源与字段名参考 docs/agents 下的仓库约定或 README');

  throw new KdsvcError(
    EXIT_CODES.AUTH_FAILED,
    `金蝶登录失败 (LoginResultType=${raw.LoginResultType}): ${message || '(无错误信息)'}`,
    hints,
  );
}
