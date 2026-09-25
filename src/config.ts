import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';

export type AuthMode = 'app' | 'password';
export type AccessMode = 'readonly' | 'readwrite';

export interface Profile {
  'server-url': string;
  'acct-id': string;
  auth: AuthMode;
  /** auth: password 时必填 */
  username?: string;
  password?: string;
  /** auth: app 时必填 */
  'app-id'?: string;
  'app-secret'?: string;
  lcid?: number;
  mode?: AccessMode;
}

export interface AppConfig {
  'default-profile': string;
  profiles: Record<string, Profile>;
}

export function configDir(): string {
  return process.env.KD_CONFIG_DIR || path.join(os.homedir(), '.kingdee-cli');
}

export function configFilePath(): string {
  return path.join(configDir(), 'config.yaml');
}

/** 生成 config init 的初始模板（不含真实凭据） */
export function templateConfig(): AppConfig {
  return {
    'default-profile': 'dev',
    profiles: {
      dev: {
        'server-url': 'http://your-server:8080/k3cloud/',
        'acct-id': 'your-acct-id',
        auth: 'app',
        username: 'integration-user',
        'app-id': 'your-app-id',
        'app-secret': 'your-app-secret',
        lcid: 2052,
        mode: 'readwrite',
      },
    },
  };
}

/** 写入配置文件并尽力设置 600 权限（Windows 下为无害 no-op） */
export function saveConfig(config: AppConfig, force: boolean): string {
  const file = configFilePath();
  if (fs.existsSync(file) && !force) {
    throw new ConfigError(`配置文件已存在: ${file}（使用 --force 覆盖）`);
  }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file, stringify(config), 'utf8');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows/NTFS 下 chmod 无意义，静默跳过
  }
  return file;
}

export function loadConfigFile(): { file: string; config: AppConfig } | null {
  const file = configFilePath();
  if (!fs.existsSync(file)) return null;
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`配置文件格式无效（应为 YAML 对象）: ${file}`);
  }
  const config = parsed as AppConfig;
  if (typeof config['default-profile'] !== 'string' || typeof config.profiles !== 'object' || config.profiles === null) {
    throw new ConfigError(`配置文件缺少 default-profile 或 profiles 字段: ${file}`);
  }
  return { file, config };
}

/**
 * 加载生效 profile：文件配置 + KD_ 环境变量覆盖。
 * 环境变量优先级最高，用于 CI / 无头场景。
 */
export function resolveProfile(nameOverride?: string): { name: string; profile: Profile } {
  const loaded = loadConfigFile();
  const name = process.env.KD_PROFILE || nameOverride || loaded?.config['default-profile'];
  if (!name) {
    throw new ConfigError('未指定 profile 且配置文件中没有 default-profile');
  }

  const base: Partial<Profile> = loaded?.config.profiles?.[name] ?? {};

  // 校准发现：profile 名不存在时报"配置无效/字段未配置"极具误导性。
  // 仅当文件里确实没有该 profile 且完全无 KD_ 环境变量兜底时，才明确报不存在
  // （保留 CI 场景：纯 KD_* 环境变量即可运行，无需文件里存在同名 profile）
  const hasEnvOverride = [
    'KD_SERVER_URL', 'KD_ACCT_ID', 'KD_AUTH', 'KD_USERNAME', 'KD_PASSWORD',
    'KD_APP_ID', 'KD_APP_SECRET', 'KD_LCID', 'KD_MODE',
  ].some((k) => process.env[k] !== undefined);
  if (loaded && !(name in loaded.config.profiles) && !hasEnvOverride) {
    throw new ConfigError(
      `profile "${name}" 不存在（现有: ${Object.keys(loaded.config.profiles).join(', ') || '无'}）；` +
      '可编辑配置文件添加，或运行 kd config init 生成模板',
    );
  }

  const env = (k: string) => process.env[`KD_${k}`];
  const profile: Profile = {
    'server-url': env('SERVER_URL') ?? base['server-url'] ?? '',
    'acct-id': env('ACCT_ID') ?? base['acct-id'] ?? '',
    auth: (env('AUTH') as AuthMode) ?? base.auth ?? 'app',
    username: env('USERNAME') ?? base.username,
    password: env('PASSWORD') ?? base.password,
    'app-id': env('APP_ID') ?? base['app-id'],
    'app-secret': env('APP_SECRET') ?? base['app-secret'],
    lcid: env('LCID') ? Number(env('LCID')) : base.lcid ?? 2052,
    mode: (env('MODE') as AccessMode) ?? base.mode ?? 'readwrite',
  };

  validateProfile(name, profile);
  return { name, profile };
}

export function validateProfile(name: string, p: Profile): void {
  const errors: string[] = [];
  if (!p['server-url']) errors.push('server-url 未配置（KD_SERVER_URL）');
  else if (!p['server-url'].endsWith('/')) errors.push('server-url 必须以 / 结尾');
  if (!p['acct-id']) errors.push('acct-id 未配置（KD_ACCT_ID）');
  if (p.auth === 'app') {
    if (!p['app-id']) errors.push('auth=app 需要 app-id（KD_APP_ID）');
    if (!p['app-secret']) errors.push('auth=app 需要 app-secret（KD_APP_SECRET）');
    if (!p.username) errors.push('auth=app 需要 username（集成用户，KD_USERNAME）');
  } else if (p.auth === 'password') {
    if (!p.username) errors.push('auth=password 需要 username（KD_USERNAME）');
    if (!p.password) errors.push('auth=password 需要 password（KD_PASSWORD）');
  } else {
    errors.push(`未知 auth 模式: ${String(p.auth)}（支持 app | password）`);
  }
  if (errors.length > 0) {
    throw new ConfigError(`profile "${name}" 配置无效:\n  - ${errors.join('\n  - ')}`);
  }
}

export function listProfiles(): {
  file: string;
  'default-profile': string;
  profiles: Array<Record<string, unknown>>;
} {
  const loaded = loadConfigFile();
  if (!loaded) {
    throw new ConfigError(`配置文件不存在: ${configFilePath()}（先运行 kd config init）`);
  }
  const masked = Object.entries(loaded.config.profiles).map(([name, p]) => ({
    name,
    'server-url': p['server-url'],
    'acct-id': p['acct-id'],
    auth: p.auth,
    username: p.username,
    password: p.password ? '******' : undefined,
    'app-id': p['app-id'],
    'app-secret': p['app-secret'] ? '******' : undefined,
    lcid: p.lcid,
    mode: p.mode,
    default: name === loaded.config['default-profile'],
  }));
  return {
    file: loaded.file,
    'default-profile': loaded.config['default-profile'],
    profiles: masked,
  };
}

export class ConfigError extends Error {}
