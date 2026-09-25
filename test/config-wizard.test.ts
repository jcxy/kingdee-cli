import { describe, expect, it, vi } from 'vitest';
import { buildConfigInteractively, type Ask } from '../src/config-wizard.js';

/** 脚本化 ask：按序返回答案队列；记录收到的提问用于断言重问行为 */
function scriptAsk(answers: string[]) {
  const questions: string[] = [];
  const ask: Ask = async (label) => {
    questions.push(label);
    if (answers.length === 0) throw new Error('答案队列耗尽（重问次数超出预期）');
    return answers.shift()!;
  };
  return { ask, questions };
}

describe('config 配置向导（纯逻辑）', () => {
  it('app 分支全流程：生成合法 AppConfig，非法 auth 原地重问', async () => {
    const { ask, questions } = scriptAsk([
      'dev',            // profile 名
      'http://10.0.0.5/k3cloud/', // server-url（已带尾斜杠）
      'acct-1',         // 账套
      'x', 'app',       // auth 非法一次后回答 app
      'int-user',       // 用户名
      'aid', 'asecret', // app 凭据
      '2052x', '2052',  // lcid 非法一次后正确输入
      '',               // mode 默认
    ]);
    const config = await buildConfigInteractively(ask);
    expect(config['default-profile']).toBe('dev');
    const p = config.profiles.dev;
    expect(p).toMatchObject({
      'server-url': 'http://10.0.0.5/k3cloud/',
      'acct-id': 'acct-1',
      auth: 'app',
      username: 'int-user',
      'app-id': 'aid',
      'app-secret': 'asecret',
      lcid: 2052,
      mode: 'readwrite',
    });
    // 认证模式问题被问了两次（第一次答案非法）
    expect(questions.filter((q) => q.includes('认证模式'))).toHaveLength(2);
    // lcid 非法也原地重问而非中止
    expect(questions.filter((q) => q.includes('lcid'))).toHaveLength(2);
  });

  it('password 分支：问密码而非 app 凭据；server-url 自动补尾斜杠', async () => {
    const { ask } = scriptAsk([
      'report',               // profile 名
      'http://10.0.0.5/k3cloud', // 尾斜杠缺失
      'acct-2',
      'password',
      'report-user',
      'pass123',
      '2052',
      'readonly',
    ]);
    const config = await buildConfigInteractively(ask);
    const p = config.profiles.report;
    expect(p).toMatchObject({
      'server-url': 'http://10.0.0.5/k3cloud/',
      auth: 'password',
      password: 'pass123',
      mode: 'readonly',
    });
    expect(p['app-id']).toBeUndefined();
  });

  it('带默认值项回车取默认；必填项空回车重问直到非空', async () => {
    const { ask } = scriptAsk([
      '',                    // profile 名：回车取默认 dev
      'http://h/k3cloud/', 'acct-3', 'app',
      '', 'user2',           // 用户名：空一次后重问输入
      'aid', 'asecret', '', '',
    ]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const config = await buildConfigInteractively(ask);
    stderrSpy.mockRestore();
    expect(config['default-profile']).toBe('dev');
    expect(config.profiles.dev.username).toBe('user2');
  });
});
