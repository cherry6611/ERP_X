# 系统配置模块（`server/modules/system-config/`）

覆盖需求书 **B-03 系统参数与业务字典 / B-07 数据保留与合规归档 / B-08 编号规则可配置**，
并承载 **B-04** 所需的可配置安全策略读取（登录锁定阈值、密码有效期、强制 MFA 角色）。

## 职责

- **字典**（`sys_dict`）：成本类型、费用类别、附件类型、发票类型、税率档位、交付物类型。
  读取走 `DictService`（60s 内存缓存 + epoch 失效），**字典缺失时回落到代码内默认值**，
  保证页面不会因缺种子而空白。
- **参数**（`sys_param`）：审批阈值、个税减除费用、密码有效期、登录锁定、附件上限、
  病毒扫描提供方、编号是否允许重用等。`editable = 0` 的参数为口径红线，界面只读。
- **编号规则**（`sys_code_rule`）：前缀、日期段（YYYYMM/YYYY/NONE）、流水位数、
  重置策略（never/yearly/monthly）、是否允许重用。`generateBizCode` 按 `bizType`
  或**前缀反查**规则，因此 30+ 处既有调用点零改动即获得可配置能力。
- **数据保留**（`sys_data_retention_policy` + `comp_audit_log_archive` + `sys_pii_request`）。

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/system/dictionary/options` | 登录即可（前端下拉只读） |
| GET | `/api/system/dictionary?dictType=` | `admin` |
| POST | `/api/system/dictionary` | `admin` |
| POST | `/api/system/dictionary/:dictType/:dictKey/delete` | `admin` |
| GET | `/api/system/params` | 登录即可（设置页展示） |
| POST | `/api/system/params/:paramKey` | `admin`（`editable=0` 一律拒绝） |
| GET | `/api/system/code-rules`、POST `/api/system/code-rules` | `admin` |
| GET | `/api/system/retention-policies` | `audit` 能力 |
| POST | `/api/system/retention-policies/:dataType` | `admin` |

## 关键约束

- **内置字典项不允许删除**（`builtin = 1` → 409，提示改为停用）；
  非内置项在被业务表引用时也拒绝删除（引用计数见 `SystemConfigService.countReferences`）。
- **编号前缀唯一**：两个业务类型同前缀会导致编号空间重叠，保存时返回 409。
- **财务类单据编号禁止重用**（`NO_REUSE_BIZ_TYPES`：VOUCHER/INVOICE/RECEIPT/PAYMENT/
  PAYROLL/AP_BILL/AR_BILL），尝试开启 `allowReuse` 直接 400。
- **审计类数据只允许 archive**：`audit_log` / `login_audit` 设为 `delete` 返回 400（NFR-S8）。
- 写入后必须调用 `DictService.invalidate()`，否则多实例读到旧值。

## 状态机

无显式状态机；保留策略有执行状态（`last_run_at` / `last_run_count`），
PII 工单状态：`pending → approved → completed | rejected`。

## 定时任务

| trigger | 周期 | 行为 |
|---|---|---|
| `retention_daily` | `30 3 * * *` | 按策略归档/清理（审计日志、登录审计、登录会话、站内信） |

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/system-config
```

（当前该模块以集成行为为主，由 `server/test/integration/migration-chain.spec.ts`
验证其建表与种子迁移可在全新库执行；`server/common/utils/biz-code.spec.ts`
覆盖编号规则的日期段与缓存失效。）

## 需业务确认

1. 编号前缀命名规范（当前种子含 `CTR`/`QUO`/`VCH` 等 50+ 业务类型）。
2. 各数据保留年限（默认审计类 730 天、会话 30 天、站内信 365 天）。
3. PII 脱敏的字段清单（当前清空姓名/手机/身份证/银行账号/地址/紧急联系人）。
