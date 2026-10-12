# 项目交付模块升级 — 接口自测数据留档（2026-10-12）

测试目的：交付物验收闭环、里程碑基线/权重、进度自动重算、EVM 指标、结项闭环的接口级验证。

## 测试数据清单（已删除）

| 表 | 编号/键 | 内容 |
|---|---|---|
| erp_project | PRJ2026100002 `[API_TEST]交付闭环验证项目` | budget 100000，contractId=74b77f86（CTR2026100001），生命周期 initiating→closed |
| erp_project_milestone | `[API_TEST]里程碑A` | planDate/baseline 2026-10-20，weight 60，已达成 |
| erp_project_milestone | `[API_TEST]里程碑B` | planDate/baseline 2026-11-15，weight 40，已达成 |
| erp_project_milestone | `[API_TEST]里程碑C(基线过期)` | baseline 2026-09-30，weight 10，已达成（用于 EVM PV/逾期） |
| erp_deliverable | DLV2026100001 `[API_TEST]数据集交付物` | pending→submitted→returned→submitted→accepted |
| erp_deliverable | DLV2026100002 `[API_TEST]验收报告交付物` | pending→submitted→accepted |
| erp_project_cost | `[API_TEST]COST-001` | amount 50000，period 2026-10（用于 CPI/EAC） |

## 验证结论

- 里程碑基线/权重：创建时 baselineDate=forecastDate=planDate 自动落库 ✓
- 进度自动重算：达成 A（60）→ progress 60；全达成（110/110）→ 100 ✓
- 交付物状态机：pending→submitted→accepted、submitted→returned→submitted，类型校验 dataset/report/software/doc/other ✓
- 状态机卡点：initiating 状态 deliver 拒绝；存在未验收交付物 accept 拒绝；里程碑未达成 close 拒绝；close 缺 closeSummary 拒绝 ✓
- 结项：close 落 closeSummary/satisfaction(5)/retrospective/closedAt ✓；合同回写条件：存在未结项项目时合同保持 active（负向验证）✓
- EVM（BI /api/bi/project-financial-health）：EV=100000、PV=10000 → SPI=10；AC=50000 → CPI=2、EAC=50000；overdueMilestoneCount=1 ✓；无权重里程碑项目 spi/cpi/eac=null ✓
- 周预警 automation：SQL 插桩验证扫描逻辑（真实数据当前无命中、无误报）；触发器 delivery_warning_weekly 已创建并 ENABLE（Active=true）；发送链路复用已验证的 sendAdminNotification
