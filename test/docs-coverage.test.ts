import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 文档覆盖守护（T6 验收项）：cli.ts 里存在的命令必须在 README 有用法说明、
 * skill 知识文件有覆盖。新增命令而忘记写文档时，这里立刻失败。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const skill = fs.readFileSync(path.join(ROOT, 'docs', 'kd-skill.md'), 'utf8');

/** 从 cli.ts 提取实际命令面（config 的子命令组装为 config init/list/test） */
function actualCommands(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
  const names = [...src.matchAll(/\.command\('([a-z-]+)'\)/g)].map((m) => m[1]);
  const top: string[] = [];
  for (let i = 0; i < names.length; i++) {
    if (names[i] === 'config') {
      // 紧随其后的 init/list/test 是 config 子命令
      while (i + 1 < names.length && ['init', 'list', 'test'].includes(names[i + 1])) {
        top.push(`config ${names[++i]}`);
      }
      top.push('config');
    } else {
      top.push(names[i]);
    }
  }
  return top;
}

describe('文档与命令面同步', () => {
  it('README 覆盖全部命令（kd <command> 用法出现，词边界防子串假通过）', () => {
    for (const cmd of actualCommands()) {
      // kd query 不能被 kd query-json 满足；kd delete 不能被 kd delete-chain 满足
      expect(readme, `README 缺少命令 kd ${cmd}`).toMatch(new RegExp(`kd ${cmd}(?![-\\w])`));
    }
  });

  it('README 覆盖安全闸门语义与退出码契约', () => {
    for (const term of ['dry-run', '--yes', '--max-count', 'readonly', 'exit 7', 'exit 6', 'exit 5']) {
      expect(readme, `README 缺少闸门/契约关键词: ${term}`).toContain(term);
    }
  });

  it('skill 知识文件覆盖核心命令与两条工作流', () => {
    for (const cmd of [
      'query-json', 'count', 'query-file', 'query-range', 'view', 'metadata', 'aliases',
      'save', 'submit', 'audit', 'unaudit', 'delete', 'delete-chain',
    ]) {
      expect(skill, `skill 文件缺少命令 ${cmd}`).toContain(cmd);
    }
    for (const term of ['追踪字段', '工作流 1', '工作流 2', 'AGENTS.md 粘贴片段']) {
      expect(skill, `skill 文件缺少: ${term}`).toContain(term);
    }
  });

  it('skill 文件的 formId 速查与 alias.ts 别名表同步（含别名=formId 映射）', () => {
    const aliasSrc = fs.readFileSync(path.join(ROOT, 'src', 'alias.ts'), 'utf8');
    const pairs = [...aliasSrc.matchAll(/alias: '([a-z-]+)',\s*formId: '([^']+)',/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    );
    expect(pairs.length).toBeGreaterThan(0); // 提取正则失效时立即暴露，不能静默通过
    for (const p of pairs) {
      expect(skill, `skill 文件缺少别名映射 ${p}`).toContain(p);
    }
  });
});
