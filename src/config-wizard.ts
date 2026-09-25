/**
 * 交互式配置向导：kd config init 在 TTY 下逐项询问，生成可直接使用的合法 YAML。
 * ask 函数注入——CLI 用 readline 实现，测试用脚本化答案队列；同一逻辑两条路验证。
 * 输入非法（必填为空/枚举外）时原地重问，不让用户从头再来。
 */
import type { AppConfig, Profile } from './config.js';

/** 提问原语：label 已含默认值提示；返回 trim 后的回答（空串 = 用户直接回车） */
export type Ask = (label: string, defaultValue?: string) => Promise<string>;

async function askNonEmpty(ask: Ask, label: string, defaultValue?: string): Promise<string> {
  for (;;) {
    const answer = await ask(label, defaultValue);
    const value = answer || defaultValue || '';
    if (value) return value;
    process.stderr.write('  值不能为空，请重新输入\n');
  }
}

async function askChoice(
  ask: Ask,
  label: string,
  choices: string[],
  defaultValue: string,
): Promise<string> {
  for (;;) {
    const answer = await ask(`${label}（${choices.join('/')}）`, defaultValue);
    const value = answer || defaultValue;
    if (choices.includes(value)) return value;
    process.stderr.write(`  只支持 ${choices.join(' | ')}，请重新输入\n`);
  }
}

/** server-url 自动补尾斜杠（K3Cloud 站点地址的硬性要求，替用户代劳而非报错） */
async function askServerUrl(ask: Ask): Promise<string> {
  for (;;) {
    const value = await askNonEmpty(ask, 'K3Cloud 服务器地址（如 http://your-server:8080/k3cloud）');
    if (!/^https?:\/\//.test(value)) {
      process.stderr.write('  地址必须以 http:// 或 https:// 开头，请重新输入\n');
      continue;
    }
    return value.endsWith('/') ? value : `${value}/`;
  }
}

/** 正整数（lcid 等数值项）：非法输入原地重问，与向导整体"重问不中止"契约一致 */
async function askPositiveInt(ask: Ask, label: string, defaultValue: string): Promise<number> {
  for (;;) {
    const value = (await ask(label, defaultValue)) || defaultValue;
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
    process.stderr.write(`  必须是正整数（如 ${defaultValue}），请重新输入\n`);
  }
}

export async function buildConfigInteractively(ask: Ask): Promise<AppConfig> {
  process.stderr.write('kd 配置向导——逐项回答生成配置文件（回车取默认值，凭据只写入本机配置文件）\n\n');

  const name = await askNonEmpty(ask, 'profile 名称', 'dev');
  const serverUrl = await askServerUrl(ask);
  const acctId = await askNonEmpty(ask, '账套 ID (acct-id)');
  const auth = await askChoice(ask, '认证模式', ['app', 'password'], 'app');
  const username = await askNonEmpty(ask, '用户名（app 模式 = 集成用户）');

  const profile: Profile = {
    'server-url': serverUrl,
    'acct-id': acctId,
    auth: auth as Profile['auth'],
    username,
    lcid: 2052,
    mode: 'readwrite',
  };

  if (auth === 'app') {
    profile['app-id'] = await askNonEmpty(ask, 'app-id（第三方应用授权）');
    profile['app-secret'] = await askNonEmpty(ask, 'app-secret');
  } else {
    profile.password = await askNonEmpty(ask, '密码');
  }

  profile.lcid = await askPositiveInt(ask, '语言 (lcid，2052=简体中文)', '2052');
  profile.mode = (await askChoice(ask, '访问模式', ['readwrite', 'readonly'], 'readwrite')) as Profile['mode'];

  return { 'default-profile': name, profiles: { [name]: profile } };
}
