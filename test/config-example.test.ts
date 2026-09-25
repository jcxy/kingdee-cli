import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateProfile, templateConfig, type AppConfig, type Profile } from '../src/config.js';

/**
 * profiles.example.yaml 与实际配置 schema 的一致性守护（T6 验收项）：
 * 示例文件漂移（字段拼错、缺必填、auth/mode 拼写错误）时测试失败，
 * 保证「照抄示例填凭据」的用户和 agent 不会拿到一份无效配置。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, 'profiles.example.yaml');

const SCHEMA_KEYS = [
  'server-url',
  'acct-id',
  'auth',
  'username',
  'password',
  'app-id',
  'app-secret',
  'lcid',
  'mode',
] as const;

function loadExample(): AppConfig {
  return parse(fs.readFileSync(EXAMPLE, 'utf8')) as AppConfig;
}

describe('profiles.example.yaml 与配置 schema 一致性', () => {
  it('结构合法：default-profile 指向已存在的 profile', () => {
    const config = loadExample();
    expect(typeof config['default-profile']).toBe('string');
    expect(Object.keys(config.profiles)).toContain(config['default-profile']);
  });

  it('每个示例 profile 都通过 validateProfile（必填齐全、auth/mode 合法）', () => {
    const config = loadExample();
    for (const [name, profile] of Object.entries(config.profiles)) {
      expect(() => validateProfile(name, profile as Profile)).not.toThrow();
    }
  });

  it('profile 字段不超出 schema（拼错字段名立刻暴露）', () => {
    const config = loadExample();
    for (const profile of Object.values(config.profiles)) {
      for (const key of Object.keys(profile)) {
        expect(SCHEMA_KEYS).toContain(key);
      }
    }
  });

  it('auth/mode 演示值都在合法枚举内，且两种 auth 模式都有示例', () => {
    const config = loadExample();
    const auths = new Set(Object.values(config.profiles).map((p) => p.auth));
    expect([...auths]).toEqual(expect.arrayContaining(['app', 'password']));
    const modes = new Set(Object.values(config.profiles).map((p) => p.mode));
    for (const m of modes) {
      expect(['readonly', 'readwrite']).toContain(m);
    }
    // readonly 模式必须有示例——它是安全闸门文档的一部分
    expect(modes).toContain('readonly');
  });

  it('示例字段与 kd config init 模板同源（不漂移）', () => {
    const config = loadExample();
    const tpl = templateConfig().profiles.dev;
    const example = config.profiles[config['default-profile']];
    expect(Object.keys(example).sort()).toEqual(Object.keys(tpl).sort());
  });
});
