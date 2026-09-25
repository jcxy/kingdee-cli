---
name: kd
description: 用 kd 命令行操作金蝶云星空（K3Cloud）：查单、写单、月结删单。含 formId 速查表、字段知识、输出契约与完整工作流。当任务涉及金蝶单据查询/导出/写入/删除链时使用。
---

# kd — 金蝶云星空 CLI（agent 操作手册）

`kd` 是 agent-first CLI：**stdout 永远是单行 JSON**，退出码语义固定。解析 JSON、看
exit code、读 `error.hints`，即可决定下一步，无需人类介入。

## 输出契约

- 成功：`{"ok":true,"command":"...","data":{...}}`，exit 0
- 失败：`{"ok":false,"command":"...","data":{部分成果?},"error":{"code":N,"message":"...","hints":[...]}}`
- 诊断信息在 stderr，可忽略；`--pretty` 仅人类排查时用

| exit | 含义 | agent 应对 |
| --- | --- | --- |
| 0 | 成功 | 继续 |
| 2 | 参数/配置错误 | 读 error.message 修正参数 |
| 3 | 认证失败 | 让用户 `kd config test` 检查凭据，不要盲目重试 |
| 4 | 金蝶业务拒绝（状态不允许/被锁定） | 读 hints；`kd view` 核对单据状态后再定策略 |
| 5 | 网络/超时，**状态未知** | 重试写操作前必须先查询核实 |
| 6 | readonly 拒绝写 | 改用 readwrite profile 或向用户申请权限 |
| 7 | 达安全上限（data 带已取得部分） | 缩小 filter 或显式调高上限 |

## formId 速查（--form 接受别名或 formId，未知原样透传）

sales-order=SAL_SaleOrder 销售订单 | sal-outstock=SAL_OUTSTOCK 销售出库单 |
sal-returnstock=SAL_RETURNSTOCK 销售退货单 | ar-receivable=AR_receivable 应收单 |
ar-receivebill=AR_RECEIVEBILL 收款单 | ar-refundbill=AR_REFUNDBILL 收款退款单 |
inventory=STK_Inventory 即时库存 | transfer-direct=STK_TransferDirect 直接调拨单 |
transfer-out=STK_TRANSFEROUT 分布式调出单 | other-outstock=STK_MisDelivery 其他出库单 |
other-instock=STK_MISCELLANEOUS 其他入库单 | rate=BD_Rate 汇率 | material=BD_MATERIAL 物料

完整/最新清单：`kd aliases`。字段拼不准先 `kd metadata --form <f>` 查元数据。

## 追踪字段（delete-chain 反查依据）

- delete-chain 按「追踪字段」反查全链单据：字段 key 在 chains.yaml 的 `traceField`
  按链配置，或 CLI `--trace-field` 覆盖（默认 `FTraceId`）；站点通常有自定义字段
  存外部单据标识，先 `kd metadata --form <f>` 确认实际字段名后配置。
- 反查表达式如 `--filter "<追踪字段>='<id>'"`（filter 原样下发金蝶，值需自行保证
  引号闭合）；delete-chain 的 `--trace-id` 值含单引号会被 CLI 直接拒绝（注入防御）。
- FID = 单据内码；FBillNo = 单据编号；FDocumentStatus = 单据状态
  （A 创建/B 审核中/C 已审核/D 重新审核）；FDate = 日期；FQty = 数量。
- **校准发现（真实环境实测）：枚举字段不支持 .FName 后缀**——`FDocumentStatus.FName`
  会报「元数据中标识为FDocumentStatus的字段不存在」，直接查 `FDocumentStatus` 返回枚举值
  （如 "C"）。基础资料字段才用 `.F` 子字段（如 `FMaterialId.FNumber`）。
- **数字型字段过滤不加引号**：`FID=7845670` ✓；`FID='7845670'` 产生非法 SQL——
  query 报错、**count 可能静默返回假数据**（危险！）。字符串字段才加引号
  （如 FBillNo='x'，已实测正常）。
- 金蝶 filter 语法是类 SQL 表达式：`FBillNo='XSDD0001'`、`FDate>='2026-01-01' and FQty>0`。
- **单据状态机与删除规则**（实测）：A 创建 → submit → B 审核中 → audit → C 已审核；
  delete 只允许 A（创建/暂存）状态；unaudit 使 C → B；B 状态删除前需处理提交状态。
  delete-chain 已内置正确顺序。
- **count 大表保护**：扫描达 --max（默认 100000）仍未完时返回 `count:null, atLeast:N`
  （下界语义）；大表（如即时库存）无 filter 时会触发此语义。

## 工作流 1：查询评估（先探代价，再取数据）

```bash
# 1) 探测行数（轻量计数，exit 7 时返回 atLeast 下界）
kd count --form sales-order --filter "FDate>='2026-09-01'"
# 2) 行数少 → 直接取对象数组
kd query-json --form sales-order --fields "FBillNo,FDate,FDocumentStatus" --filter "FDate>='2026-09-01'"
# 3) 行数多 → 流式落盘（ndjson 逐行 JSON 对象；csv 人类表格）
kd query-file --form sales-order --fields "FBillNo,FAmount" --out sales.ndjson
# 4) 万行级跨月数据 → 日期分片，防单次超时
kd query-range --form sales-order --fields "FBillNo" --from 2026-01-01 --to 2026-09-30 --granularity month
# 5) 单张单据细节
kd view --form sales-order --number XSDD0001
```

要点：`--fields` 决定列（先 metadata 确认）；`--max` 熔断默认各命令不同；query-file
不占内存，大数据一律用它而不是 query-all。

## 工作流 2：月结删单（delete-chain）

场景：删除一笔单据的全链下游（应收单 → 出库单 → 销售订单）。

```bash
# 1) dry-run（默认）：反查全链、输出逐环节影响面，零写操作
kd delete-chain --trace-id ST-202609-0001
# → data.steps[] 每环节 {form, refs[{id,number}], skipped?}
# 2) 核对影响面与用户预期一致后，显式确认执行
kd delete-chain --trace-id ST-202609-0001 --yes
# 3) 中途失败（exit 4/5）：单条 JSON 同时携带 data.steps 完整执行报告——
#    已删环节自动跳过，修复诱因后原命令重跑即可
```

要点：顺序是下游→上游（先删应收单才能删订单）；未下推到底的环节自动跳过；
总数超 `--max-count`（默认 50）熔断 exit 7。

## 下推（push）与转换规则（真实环境实测）

- 站点**未启用订单→出库单默认转换规则**：push 不带 `--rule` 报
  「未启用默认转换规则，转换规则内码（RuleId）必填」。
- 规则查询：`kd query-json --form BOS_ConvertRule --fields "FNumber,FName" --filter "FName like '%出库%'"`。
- 命名型规则 FNumber（如 `ESS_SALESORDER_TO_OUTSTOCK`）可直接作 --rule；
  GUID 型 FNumber 加载报「运行时不允许加载」——该规则被禁用或非运行时可用。
- push 失败报 exit 4 + 具体业务条件（权限/单据状态/字段约束等）属正常校验，
  按报错逐项满足即可；接口协议层已验证正常。

## 写操作安全规则（务必遵守）

1. **先 dry-run 后 --yes**：unaudit/delete/delete-chain 不带 `--yes` 就是只读预演。
   非 TTY（agent）下永远不会交互确认——这是设计，不是故障。
2. **选择器三选一**：`--ids` / `--numbers` / `--filter` 严格互斥，同时传直接报错。
   用 `--filter` 时先 `kd count` 评估命中数，再执行（超 `--max-count` 默认 50 会熔断）。
3. **提交 → 审核有先后**；删除已审核单据前必须先反审核（delete-chain 已内置该顺序）。
4. **exit 5 后不要立即重试写操作**：状态未知，先 `kd view`/`kd query` 核实。

## AGENTS.md 粘贴片段（自包含，复制即用）

```markdown
## 金蝶操作（kd）

kd 的 stdout 是单行 JSON：{ok, command, data, error:{code,message,hints}}；退出码
0 成功 / 2 参数 / 3 认证 / 4 金蝶业务拒绝 / 5 网络状态未知 / 6 readonly 拒绝 / 7 达上限。
每次看 exit code + error.hints 决定下一步；exit 5 后重试写操作前必须先查询核实。

常用命令：
- 查询：kd query-json --form <别名> --fields "FBillNo,FDate" --filter "FDate>='2026-01-01'"
  （枚举字段直接查值不支持 .FName；数字型字段过滤不加引号，如 FID=123）
  行数探测 kd count；大数据落盘 kd query-file --out <file>；跨月拉取 kd query-range
  --from <d> --to <d> --granularity month；单据细节 kd view --form <别名> --number <编号>；
  字段确认 kd metadata --form <别名>；别名表 kd aliases
- formId 别名：sales-order=销售订单 sal-outstock=销售出库单 ar-receivable=应收单
  inventory=即时库存 material=物料（其余见 kd aliases）；delete-chain 按
  追踪字段反查（chains.yaml 配置 traceField，默认 FTraceId）
- 写操作（readonly profile 会被 exit 6 拒绝）：kd save --form <别名> --data '<JSON>'；
  kd submit/audit --form <别名> --numbers <编号们>；kd unaudit/delete 默认 dry-run
  输出影响面，核对后加 --yes 才执行；--ids/--numbers/--filter 三选一严格互斥；
  --filter 先 kd count 评估（超 --max-count 默认 50 熔断）
- 月结删单：kd delete-chain --trace-id <追踪ID> 先 dry-run 看全链影响面（应收→出库→
  订单），确认后 --yes 执行；失败时 JSON 仍携带已完成环节报告，修复后重跑自动跳过已完成环节
```
