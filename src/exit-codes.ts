/**
 * 全局退出码契约（spec Implementation Decisions）：
 * 0 成功 / 2 参数错误 / 3 认证失败 / 4 金蝶业务拒绝 / 5 网络错误 / 6 readonly 拒绝 / 7 达到批量上限
 */
export const EXIT_CODES = {
  OK: 0,
  PARAM_ERROR: 2,
  AUTH_FAILED: 3,
  KINGDEE_REJECTED: 4,
  NETWORK_ERROR: 5,
  READONLY_DENIED: 6,
  MAX_COUNT_REACHED: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** stdout 的统一 JSON 输出契约 */
export interface CliOutput<T = unknown> {
  ok: boolean;
  command: string;
  data?: T;
  error?: {
    code: ExitCode;
    /** 人类/agent 可读的诊断信息（已翻译，非金蝶原始文案） */
    message: string;
    /** 可操作的修复提示 */
    hints?: string[];
  };
}
