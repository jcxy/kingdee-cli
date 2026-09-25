# kd — agent 优先的金蝶云星空 K3Cloud 命令行工具

`kd` 让人类和 AI agent 用同一条命令行操作金蝶云星空（K3Cloud）：查单、写单、月结删单。
stdout 永远是**单行 JSON**（`{ok, command, data, error}`），诊断信息走 stderr，退出码语义固定——
这正是 agent 解析输出、判断成败、决定下一步所需要的全部契约。

## 特性

- **agent-first 输出契约**：stdout 单行 JSON，`--pretty` 才美化；exit code 0/2/3/4/5/6/7 语义固定
- **15 个通用原语 + delete-chain 复合命令**：查询/查看/元数据/大数据量导出/保存/提交/审核/反审核/删除/自定义操作/下推/月结删单链
- **安全闸门**：profile 级 readonly 物理拒绝写操作；unaudit/delete/delete-chain 默认 dry-run；批量熔断防误删
- **双认证**：第三方应用授权（app，推荐）与账号密码（password），即登即用无状态
- **formId 别名**：`--form sales-order` 代替 `--form SAL_SaleOrder`

## 安装

要求 Node.js ≥ 18.14。

```bash
# 私有 npm 仓库（首次需在项目根或用户目录配置 .npmrc）
# @cvtoolman:registry=https://npm.example.com/repository/npm-hosted/
# //npm.example.com/repository/npm-hosted/:_authToken=<TOKEN>
npm i -g @cvtoolman/kingdee-cli
kd --help
```

## 快速开始

```bash
# 1. 生成配置（终端下默认交互式逐项问答，回车取默认值）
kd config init
#    或跳过交互直接生成模板后手动编辑：
#    kd config init --template
#    agent/CI 非终端环境自动使用模板，行为不变
# 2. 验证连通性与认证
kd config test
# 3. 首次查询
kd query-json --form sales-order --fields "FBillNo,FDate,FDocumentStatus" --limit 10
```

> 向金蝶管理员索取：账套 ID（acct-id）、集成用户名、第三方应用的 app-id/app-secret
> （或账号密码）。app 模式需要在 K3Cloud 后台「第三方应用」中登记并授权。

## 配置

配置文件 `~/.kingdee-cli/config.yaml`（可用 `KD_CONFIG_DIR` 改路径），完整示例见
[profiles.example.yaml](profiles.example.yaml)：

| 字段 | 说明 |
| --- | --- |
| `server-url` | K3Cloud 站点地址，**必须以 / 结尾** |
| `acct-id` | 账套 ID |
| `auth` | `app`（默认，需 app-id/app-secret/username）\| `password`（需 username/password） |
| `lcid` | 语言，2052 = 简体中文 |
| `mode` | `readwrite`（默认）\| `readonly`——readonly 下所有写命令 exit 6 拒绝 |

多 profile 场景用 `--profile <name>` 选择，或 `default-profile` 指定默认。
`kd config list` 查看全部 profile（凭据打码），`kd config test` 验证连通。

### 环境变量（CI / 无头场景，优先级最高）

`KD_CONFIG_DIR`、`KD_PROFILE`、`KD_SERVER_URL`、`KD_ACCT_ID`、`KD_AUTH`、
`KD_USERNAME`、`KD_PASSWORD`、`KD_APP_ID`、`KD_APP_SECRET`、`KD_LCID`、`KD_MODE`。

## 输出契约

- **stdout**：单行 JSON。成功 `{"ok":true,"command":"...","data":{...}}`；
  失败 `{"ok":false,"command":"...","data":{...部分成果?},"error":{"code":4,"message":"...","hints":[...]}}`
- **stderr**：人类可读诊断（提示、警告），agent 可忽略
- **退出码**：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 参数错误（选项缺失/格式非法/配置无效） |
| 3 | 认证失败（凭据错误/账套不存在/许可问题） |
| 4 | 金蝶业务拒绝（单据状态不允许、被锁定等，error.hints 给排查建议） |
| 5 | 网络错误/超时（**状态未知**，安全起见先查询核实再重试写操作） |
| 6 | readonly 模式拒绝写操作 |
| 7 | 达到批量/行数安全上限（data 携带已取得的部分成果） |

## 命令参考

全局选项：`--profile <name>`、`--mode readonly|readwrite`（临时覆盖）、`--pretty`。
`--form` 一律接受别名或金蝶 formId；`kd aliases` 列出别名表（见下文）。

### 查询类（readonly 可用）

```bash
# 二维数组（列序与 --fields 一致，最省流量）
kd query --form sales-order --fields "FBillNo,FDate" --filter "FDate>='2026-09-01'" --limit 100 --start 0

# 对象数组（按字段名 zip，agent 友好）
kd query-json --form inventory --fields "FMaterialId.FNumber,FQty" --filter "FQty>0"

# 单张单据完整数据（--id 与 --number 二选一）
kd view --form sales-order --number XSDD0001

# 表单元数据（构造 filter/fields 前先看字段）
kd metadata --form sales-order

# formId 别名表
kd aliases
```

### 大数据量（万行级）

```bash
# 探测行数：拉全量前评估代价（轻量 FID 计数）
kd count --form sales-order --filter "FDate>='2026-01-01'"
# → {"count": 18342}；达上限 → exit 7 + {"count":null,"atLeast":100000}

# 自动翻页拉完（单页上限 2000 自动翻页合并；--max 熔断默认 10000）
kd query-all --form sales-order --fields "FBillNo,FAmount" --max 50000

# 流式导出文件（ndjson 逐行对象 / csv 表头+行；逐页落盘不撑爆内存）
kd query-file --form sales-order --fields "FBillNo,FAmount" --out out.ndjson --format ndjson
kd query-file --form inventory --fields "FMaterialId.FNumber,FQty" --out stock.csv --format csv

# 按日期分片 + 翻页（月/周/日切片，跨月跨年可靠；--date-field 默认 FDate）
kd query-range --form sales-order --fields "FBillNo" --from 2025-12-15 --to 2026-01-20 --granularity month
```

### 写入类（readonly 拒绝，exit 6）

```bash
# 新增单据（--data 与金蝶 Save 接口的 data 参数一致）
kd save --form sales-order --data '{"FBillNo":"XSDD0001","FDate":"2026-09-25",...}'

# 提交 / 审核（--ids/--numbers/--filter 三选一，严格互斥）
kd submit --form sales-order --numbers XSDD0001,XSDD0002
kd audit --form sales-order --filter "FBillNo='XSDD0001'" --max-count 50

# 自定义操作（禁用/反禁用等）
kd execute-operation --form material --op Forbid --numbers WL0001

# 下推生成下游单据
kd push --form sales-order --numbers XSDD0001 --target-form sal-outstock --rule <可选规则ID>

# 反审核 / 删除（危险命令：默认 dry-run 只输出影响面；--yes 才真正执行）
kd unaudit --form sales-order --numbers XSDD0001
# → {"dryRun":true,"affected":[...],"wouldSend":{"Numbers":["XSDD0001"]},"hint":"...加 --yes 真正执行"}
kd delete --form sales-order --numbers XSDD0001 --yes
```

**选择器语义**：`--ids`（内码）/`--numbers`（编号）/`--filter`（过滤表达式）**三选一，
同时传入直接报错**（exit 2）——静默取舍会让 agent 误判执行范围。`--filter` 会先按上限
反查影响面（默认 50，`--max-count` 调整），超限 exit 7 熔断。

**非 TTY（agent/CI）下 unaudit/delete 不会交互确认**：没有 `--yes` 就保持 dry-run，
这是刻意设计——agent 必须先看影响面再显式加 `--yes`。

### delete-chain：月结删单

按追踪字段反查全链单据（应收单 → 出库单 → 销售订单），逆下推方向
逐环节反审核 + 删除。追踪字段 key 在 chains.yaml 的 `traceField` 按链配置
（或 `--trace-field` 覆盖，默认 `FTraceId`）：

```bash
# 默认 dry-run：反查全链、输出逐环节影响面，不写任何数据
kd delete-chain --trace-id ST-202609-0001
# → {"traceId":"ST-202609-0001","traceField":"FTraceId","dryRun":true,"chain":"month-end","steps":[{"form":"ar-receivable","formId":"AR_receivable","refs":[...]},...]}

# 确认影响面后执行
kd delete-chain --trace-id ST-202609-0001 --yes
```

- **降级**：某环节未命中（未下推到底）自动跳过，报告标注 `skipped`
- **熔断**：链条受影响单据总数 > `--max-count`（默认 50）→ exit 7
- **失败即停**：某环节失败 → exit 4，单条 JSON 同时携带完整执行报告与错误，
  后续环节不执行；网络类失败（exit 5）状态未知，恢复连通后重跑即可（已处理环节自动跳过）
- **自定义链条**：`~/.kingdee-cli/chains.yaml`，同名覆盖内置：

```yaml
chains:
  month-end:
    description: 月结删单（下游 → 上游）
    forms: [ar-receivable, sal-outstock, sales-order]
```

## formId 别名表

`kd aliases` 实时输出；未知别名原样透传给金蝶并在 stderr 提示。

| 别名 | formId | 业务名 |
| --- | --- | --- |
| sales-order | SAL_SaleOrder | 销售订单 |
| sal-outstock | SAL_OUTSTOCK | 销售出库单 |
| sal-returnstock | SAL_RETURNSTOCK | 销售退货单 |
| ar-receivable | AR_receivable | 应收单 |
| ar-receivebill | AR_RECEIVEBILL | 收款单 |
| ar-refundbill | AR_REFUNDBILL | 收款退款单 |
| inventory | STK_Inventory | 即时库存 |
| transfer-direct | STK_TransferDirect | 直接调拨单 |
| transfer-out | STK_TRANSFEROUT | 分布式调出单 |
| other-outstock | STK_MisDelivery | 其他出库单 |
| other-instock | STK_MISCELLANEOUS | 其他入库单 |
| rate | BD_Rate | 汇率 |
| material | BD_MATERIAL | 物料 |

## 常见错误排查

| 现象 | 排查 |
| --- | --- |
| exit 3 认证失败 | `kd config test` 核对凭据；app 模式确认第三方应用已授权集成用户；acct-id 是否为本账套 |
| exit 4 业务拒绝 | 看 `error.hints` 与金蝶错误文案；用 `kd view` 核对单据当前状态（是否已审核/已锁定） |
| exit 5 网络错误 | **写操作状态未知**——恢复连通后先 `kd query`/`kd view` 核实，再决定重试 |
| exit 6 readonly | 当前 profile 是只读模式；换 readwrite profile 或 `--mode readwrite` 临时覆盖 |
| exit 7 达上限 | 结果比预期大：缩小 `--filter` 范围，或显式调高 `--max`/`--max-count` |
| 查询字段为空 | `kd metadata --form <f>` 确认字段 key 拼写；关联字段用 `FKey.FSubKey` 形态 |
| 删单被拒 | 金蝶要求已审核单据先反审核：用 `kd delete-chain`（自动先反审核）或手动 `kd unaudit --yes` |

## Agent 集成

让 AI 工具开箱即会指挥 kd：把 [docs/kd-skill.md](docs/kd-skill.md) 安装为 skill 或将其中
「AGENTS.md 片段」粘贴到项目 AGENTS.md。片段自包含输出契约、formId 速查、字段知识与
两个完整工作流（查询评估、月结删单），不依赖本文档即可正确使用。

## 开发

```bash
npm install
npm run build            # tsc → dist/
npm test                 # build + vitest（CLI 进程边界测试，本地 stub 模拟 kdsvc）
npm run typecheck
npm run test:integration # 真实环境集成测试（需 dev 环境可写；自动清理测试数据）
```
