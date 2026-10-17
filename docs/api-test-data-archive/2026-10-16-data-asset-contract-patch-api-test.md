# 数据资产「关联合同可改」接口自测留档（2026-10-16）

> 用途：`AGENTS.md` 要求"接口自测数据用后即删，删除前留档至 `docs/api-test-data-archive/`"。
> 本文件是 `da_dataset` 三行 `[API_TEST]` 数据删除**前**的快照与完整 HTTP 证据。

## 一、改动背景

`UpdateDatasetDto` 原先**没有** `contractId`（只有 `name/source/maskLevel/status/remark`），
而 controller 用了 `whitelist + forbidNonWhitelisted` —— 于是「改关联合同」只能 400。
本轮补契约 + service patch + 放开前端下拉禁用，三态语义（写入 / 清除 / 不动）已实测。

## 二、验证环境

- 构建：`npm run build`（exit 0）→ `node dist/server/main.js`
- 健康检查：`GET /api/health` → `{"ok":true,"db":true,"scheduler":false,"feishuConfigured":true,"version":"dev"}`
- 登录：`POST /api/auth/login`（`.env` 的 `BOOTSTRAP_ADMIN_USERNAME`，admin，含 `data_asset` 能力码）→ HTTP 201
  - ⚠️ 会话 Cookie 带 `Secure` 属性而本地是 http，.NET 的 `WebSession` 不会回送它；
    自测脚本改为手工把 `Set-Cookie` 的首段塞进 `Cookie` 请求头。
- 真实合同（`erp_contract` 经 `GET /api/contracts`）：
  - **C1** = `beb6440c-9a13-409b-9803-dcac5409adae`（CTR2026100004，数据中台一期合同-2026-10-13212818）
  - **C2** = `d19a6bcf-a827-4be6-8324-40405992b1cf`（CTR2026100003，数据中台一期合同-2026-10-13212707）
- 数据集 `da_dataset` 自测前为 **0 行**（库里无历史数据，本轮是首次写入）。

## 三、修改前（旧 dist，pid 1736）的基线行为

| 请求 | 结果 |
|---|---|
| `PATCH {name}` | **400** `status: status must be one of the following values: active, offline; status: status must be a string` |
| `PATCH {name,status}` | 200（说明其余 patch 正常，卡点是 `status` 缺 `@IsOptional()`） |
| `PATCH {contractId}` | **400** `contractId: property contractId should not exist; ...` |
| `PATCH {contractId:null}` | **400** 同上 |

→ 两条结论：①「改关联合同」是**报错可见的 400**，不是静默丢弃；
② `status` 缺 `@IsOptional()` 使**任何**不带 status 的 PATCH 都 400，
而前端编辑弹窗的 payload 里从来没有 `status` —— 即"编辑数据集"当时**必然失败**。

## 四、修改后的四步（+两步补充）实测

| # | 请求 | 状态码 | 响应要点 |
|---|---|---|---|
| 1 | `POST /api/data-asset/datasets` `{name:'[API_TEST] 关联合同三态验证', source:'api-probe', maskLevel:'L2', contractId:C1, remark:'[API_TEST]'}` | **201** | `id=e9573099-…`、`code=DS2026100003`、`contractId=C1`、`contractName=数据中台一期合同-2026-10-13212818` |
| 2 | `PATCH …/datasets/{id}` `{contractId:C2}` | **200** | `contractId=C2`、`contractName=数据中台一期合同-2026-10-13212707`；再 GET 读回一致 |
| 3 | `PATCH …/datasets/{id}` `{contractId:null}` | **200** | `contractId=null`、`contractName=null`；再 GET 读回一致 |
| 4 | `PATCH …/datasets/{id}` `{contractId:'00000000-0000-4000-8000-000000000000'}` | **404** | `{"error":{"code":"NOT_FOUND","message":"关联合同不存在"}}`；再 GET 确认**未被写坏**（仍为 null） |
| 5a | `PATCH …/datasets/{id}` `{contractId:C1}` | **200** | 绑回 C1 |
| 5b | `PATCH …/datasets/{id}` `{name:'[API_TEST] 只改名字', source:'api-probe-2'}`（**不带** `contractId`/`status`） | **200** | `contractId` 仍为 C1 → `undefined` = 不动；同时也证明 `status` 修复生效 |
| 6 | `PATCH …/datasets/{id}` `{contractId:'not-a-uuid'}` | **400** | `contractId: contractId must be a UUID` |

> 第 4 步预期 400，实测 **404**：`ensureContractExists()` 抛的是 `NotFoundException`，
> 语义上是"被引用的实体不存在"。404 比 400 更准确，故保留现状并在此记录口径。

## 五、删除前的数据快照（`da_dataset`，3 行，全部为本轮自测）

```json
[
  {
    "id": "4cbdfde8-8ae6-4799-90d5-1160b2ff3b36",
    "code": "DS2026100001",
    "name": "[API_TEST] renamed",
    "source": "probe",
    "mask_level": "L2",
    "contract_id": "beb6440c-9a13-409b-9803-dcac5409adae",
    "status": "active",
    "remark": "probe",
    "_created_at": "2026-10-16T16:58:22.784Z"
  },
  {
    "id": "1266128a-3068-471b-b7fc-047173e0e237",
    "code": "DS2026100002",
    "name": "[API_TEST] 关联合同三态验证",
    "source": "api-probe",
    "mask_level": "L2",
    "contract_id": "beb6440c-9a13-409b-9803-dcac5409adae",
    "status": "active",
    "remark": "[API_TEST]",
    "_created_at": "2026-10-16T17:03:00.366Z"
  },
  {
    "id": "e9573099-99bc-46de-9f04-d6a23bdf9d4",
    "code": "DS2026100003",
    "name": "[API_TEST] 只改名字",
    "source": "api-probe-2",
    "mask_level": "L2",
    "contract_id": "beb6440c-9a13-409b-9803-dcac5409adae",
    "status": "active",
    "remark": "[API_TEST]",
    "_created_at": "2026-10-16T17:04:10.678Z"
  }
]
```

关联副表 `da_dataset_field` 自测前后均为 **0 行**（未登记任何脱敏字段）。
`DS2026100001`（`[API_TEST] renamed`）来自"修改前基线"那一步的探针数据集，同样属本轮自测数据，一并删除。

## 六、删除后

`da_dataset` 恢复为 **0 行**（与自测前一致）；`da_dataset_field` 仍为 0 行。
`da_dataset` 不在 B-09「作废不重用」的财务类单据清单内，且删除后回到 0 行，
编号回落逻辑（`MAX(seq)+1`）与自测前完全一致。
