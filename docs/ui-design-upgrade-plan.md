# 晟笙数据服务 ERP — 全项目再检查与前端 UI 美化升级方案

> 日期：2026-10-11 · 本文档为纯评估与设计产物，**不含任何代码改动**。
> 前置报告：`docs/go-live-review-and-upgrade-plan.md`（含第 6 节全量开工实施结果）。
> 标注约定：**[已验证]** = 本轮实际核查（代码巡检/上轮命令留档）；**[建议确认]** = 需业务侧核对后执行。

## 结论摘要

上轮实施（演示数据清理、G1-G4 规范修复、BI 下钻、信用预警、语义检索）已全部闭环，工程层无阻塞上线的新缺陷。本轮再检查聚焦**视觉设计层次**：当前 UI 是干净的 shadcn 默认企业风（白卡 + 1px 灰边 + 蓝主色），规范一致性已达标，但视觉「平」——指标卡纯文字裸卡、全站零阴影零渐变、图表配色硬编码、无顶栏无品牌区、Badge 状态色双轨制。本方案给出 P0/P1/P2 三级美化升级清单，全部为前端视觉层改动，不触碰后端接口、数据库与共享契约；建议作为上线后第一个迭代（P0+P1 合计约两个迭代单元）。

---

## 一、全项目增量检查结论（上轮实施后再核查）

### 1.1 上轮闭环项一览（引用 go-live 文档第 6 节）

| 项 | 结果 |
|---|---|
| `[API_TEST]` 演示数据清理 | 44 表约 76 行按外键事务删除，留档 `docs/api-test-data-archive/`，删后复核清零 |
| UI 规范修复 G1-G4 | 金额右对齐、空态引导文案、分页统一（pageSize 10 + showTotal）、状态色黄系校准全部落地 |
| BI 毛利榜下钻 | `GET /api/bi/projects/:id/cost-breakdown` + 行展开成本构成 |
| 客户信用预警 | `customer_credit_alert` cron（每日 09:00，Active=true），阈值 `CREDIT_ALERT_RATIO=0.8`，SQL 命中逻辑已插桩验证 |
| 语义检索 | `rds_ai` + `vector`，合同/项目 embedding 列 + HNSW 索引，阈值 0.4，实测距离分布合理 |
| 导航/图标/卡片规范 | 图标去重、hr PageShell、admin 卡片列数对齐、成本卡类型图标完成 |

### 1.2 本轮新发现的技术升级项（均非阻塞，属增强/观察性质）

1. **status 枚举过滤列无索引**：上轮性能核查确认核心表索引完备（code 唯一、外键、period、embedding HNSW），但 status 等枚举列暂无索引。空库起步可接受，数据量增长后（单表过万）按 M3-4 计划用 EXPLAIN 复核再补 **[已验证]**。
2. **图表配色与 Badge 色彩体系为两处技术债**：图表 hex 硬编码与 `--chart-*` token 脱节；Badge 硬编码 class 覆盖 variant（详见第二章短板 3/5）。这两项既是美观问题也是维护性债务，修一次长期受益。
3. **多环境拆分仍未决策**：单环境数据库（dev 直连生产库），M2 计划搁置中，上线后误操作风险随使用者增加而放大 **[建议确认]**。
4. **可见范围仍在默认状态**：移交清单第 1 项未见执行记录，上线前需 `+access-scope-set` **[建议确认]**。
5. **语义检索阈值 0.4 待线上调参**：当前基于两条实测样本（相似 0.196 / 无关 0.537）设定，真实数据积累后需观察召回质量再调。
6. **cron 最小粒度 30 分钟的架构约束**：信用预警与房租提醒固定每日 09:00，触发时间不可由前端动态调整，属平台限制；如需更细粒度需另行设计触发器，暂无必要。

### 1.3 工程层结论

无阻塞上线的新缺陷；运行态健康（引用上轮运行态核查留档）；升级项均为增强性质。**重心转向 UI 美观度**。

---

## 二、UI 设计现状诊断（本轮代码巡检，均附路径:行号）

**[已验证]** 本轮对设计 token、Layout 骨架、典型页面、Badge、图表、组件质感做了专项巡检，结论如下。

| # | 短板 | 现状证据 |
|---|---|---|
| 1 | **指标卡纯文字裸卡，视觉同质** | dashboard（DashboardPage.tsx:364）、costs（CostsTab.tsx:191/204）、人力概览（:392-410）全部为 `rounded-lg border bg-card p-4` + label/value 两行；仅 dashboard 有环比 delta。全站 9+ 张卡无渐变、无阴影、无强调色，成本卡虽有类型图标（上轮加）但无质感层次 |
| 2 | **零阴影、零渐变，交互反馈层缺失** | 全 client/src 仅 1 处 gradient（business-ui/error-image.tsx:8，平台文件）；pages/components 无任何 `shadow-sm/md/lg`；tailwind-theme.css:149-256 已定义的 `elevate`/hover-elevate 工具类**完全未被页面使用** |
| 3 | **图表配色硬编码，与 token 脱节** | DashboardPage.tsx:72-157 硬编码 `#3b82f6 #f59e0b #8b5cf6 #10b981 #ef4444`，未用已定义的 `--chart-1..5`（tailwind-theme.css:12-88），无共享色板常量 |
| 4 | **Layout 无顶栏，品牌感弱** | Layout.tsx:91-128：仅 `w-56` 侧栏 + main 直接 `<Outlet/>`；无面包屑、无用户区，侧栏 logo 区仅一行文字；选中态 `bg-primary/10 text-primary` 无指示条 |
| 5 | **Badge 双轨制，状态难辨** | biz-labels.ts:109-183：多状态挤 default 蓝（completed/paid/approved 与 active/executing 同色），再靠 statusClass 硬编码 `bg-emerald-100/amber-100` 覆盖语义色，非 token 驱动 |
| 6 | **无字体梯度、筛选区无容器、空态组件闲置** | --font-sans 走系统栈，无 display/数字梯度 token；LeadsTab.tsx:223-224、CostsTab.tsx:210-213 筛选区为裸 flex 横排 Select/Input；`components/ui/empty.tsx` 存在但未被任何页面使用 |

**总体印象**：规范一致性尚可（上轮 G1-G4 的功劳），但缺「设计」层——没有质感（阴影/渐变）、没有品牌层（顶栏/logo）、没有色彩体系（图表/状态色各走各的）。当前是「能用且整齐」的白盒后台，离「好看、有质感」差一层系统性升级。

---

## 三、UI 美化升级建议（分级清单）

### P0 — 质感跃升（第一个迭代单元，纯前端，约半天）

#### P0-1 指标卡质感模板（直击短板 1/2）

- **新建** `client/src/components/erp/StatCard.tsx`：
  - 结构：图标区（lucide 图标 + 强调色底色块，如 `bg-primary/10 text-primary` 按业务域映射色）+ label + 数值行 `text-2xl font-semibold tabular-nums` + 可选 delta/次级文案插槽；
  - 质感：`hover-elevate` 悬浮反馈（token 已存在，启用即可）；顶部 2px 强调色条或左侧色条二选一，保持克制；
  - Props：`{ label, value, icon?, tone?: 'primary'|'success'|'warning'|'info', delta?, hint? }`。
- **替换点**：dashboard 指标区（DashboardPage.tsx:364 起）、costs 动态指标卡（CostsTab.tsx:191/204）、hr 概览卡（:392-410）、admin-bills/admin-rent 卡（复用同一模板）。
- 工作量：小-中；验收：各页指标卡有图标、色阶区分、悬浮有阴影反馈，无布局抖动。

#### P0-2 图表色板常量化（直击短板 3）

- **新建** `client/src/utils/chart-colors.ts`：从 `--chart-1..5` CSS 变量读取（`getComputedStyle` 初始化一次），导出 `CHART_COLORS` 数组与语义色（income/cost/expense/预警色）。
- **替换点**：DashboardPage.tsx:72-157 所有硬编码 hex；后续任何新图表一律从该文件导入。
- 工作量：小；验收：dashboard 图表视觉不变（当前 hex 恰好等于 chart-1..5 的可保留等值映射），但来源变为 token。

#### P0-3 Badge 状态色重构（直击短板 5）

- **改法**：biz-labels.ts 中 STATUS_VARIANTS 语义归位——终态成功（completed/paid/approved/settled）→ success 绿；流程进行态（executing/delivering/approving）→ warning 黄；active/生效 → info 蓝；移除 statusClass 硬编码 `bg-emerald-100/amber-100`，改为扩展 Badge variant（在 tailwind-theme 已有的 info/success/warning token 上加 `badge-success` 等变体类）。
- 工作量：小；验收：任一列表页状态一眼可辨（绿=成、黄=进行中、蓝=生效、红=驳回/逾期），grep 无残留 statusClass。
- 注意：此条影响所有 StatusBadge 使用页（15+），完成后需全页视觉巡检一遍。

### P1 — 结构升级（第二个迭代单元，纯前端，约半天）

#### P1-1 Layout 顶栏 + 侧栏品牌区（直击短板 4）

- 顶栏：`h-12 border-b` 面包屑（「分组名 / 页面名」，由路由 → 导航配置映射生成，导航定义已在 Layout.tsx:48-75 集中）+ 右侧用户区（`business-ui` UserDisplay，禁止自行实现头像）。
- 侧栏头部：logo 图标块（lucide，如 `Boxes`/`Building2`，`bg-primary text-primary-foreground rounded-lg` 小方块）+ 应用名两行（主名 + 「数据服务 ERP」副名）。
- 选中态：现 `bg-primary/10 text-primary` 基础上加左侧 2px `bg-primary` 指示条。
- 工作量：中；验收：任意页可见面包屑与用户区，侧栏有品牌区，选中项有指示条。

#### P1-2 PageShell 加 actions 插槽

- PageShell.tsx:9-19 增加 `actions?: ReactNode`，渲染在标题行右侧；各页把右上角主操作按钮（新增/导出等）从页面体内移入插槽。
- 工作量：小；验收：抽查 5 页，主按钮位置统一在页头右上角。

#### P1-3 筛选区卡片化

- **新建** `client/src/components/erp/FilterBar.tsx`：卡片容器（`bg-card border rounded-lg p-3`）+ 响应式 grid 排布 + 可选标题（如「筛选」）；替换 LeadsTab.tsx:223-224、CostsTab.tsx:210-213 等裸 flex 筛选区。
- 工作量：小-中；验收：筛选控件与表格区有明确视觉分界，1280px 宽度下不换行溢出。

#### P1-4 接入结构化空态

- 启用闲置的 `components/ui/empty.tsx`：列表空态从纯文案升级为「图标 + 文案 + 引导按钮（可选）」，与上轮 G2 引导文案合并（文案保留，外壳升级）。
- 工作量：小；验收：任一空列表页显示结构化空态而非裸文字。

### P2 — 锦上添花（可选，按需排期）

| 项 | 内容 | 备注 |
|---|---|---|
| P2-1 字体梯度 | `--font-display`（标题系统栈 + tighter tracking）、金额大数 `text-2xl tabular-nums` 梯度、页头与区块标题层级拉开 | 纯 token 改动 |
| P2-2 侧栏折叠 | `components/ui/sidebar.tsx` 已存在未用，可直接启用替代自写侧栏 | 中等，回归成本高 |
| P2-3 列表动效 | AutoAnimate 列表增删（crm 线索、审批面板） | 上轮评估收益低，维持可选 |
| P2-4 空态插画 | generate_image 生成一张通用后台空态插画配 empty 组件 | 上轮未做，文案已达引导目的 |

---

## 四、影响范围与风险

- 全部改动为**前端视觉层**，不触碰后端接口、数据库、共享契约、聚合文件（P0-3 的 biz-labels.ts 为前端 utils，非契约文件）。
- P0-3 Badge 重构影响面最大（15+ 页面），需全页视觉巡检；P1-1 Layout 改动影响所有页面骨架，需浏览器巡检确认无布局回归。
- `chart.tsx` / `sidebar.tsx` / `empty.tsx` 均为 ui/ 现成组件，启用而非新造，风险低；不引入新 UI 库，遵守 AGENTS.md 设计规范（Card 禁嵌套、图标只用 lucide-react）。
- E2E 验收注意（工作区记忆）：沙箱浏览器链路 admin 按钮必隐藏、写操作必被 RLS 拒，均为预期；本轮全部为视觉改动，验收以浏览器巡检渲染为主，无写链路。

---

## 五、验收标准（文档交付）

- 本文档存在且包含：上轮闭环一览（1.1）、本轮新发现技术升级项 ≥5 条（1.2）、6 项 UI 短板每条含路径:行号证据（第二章）、P0/P1/P2 升级清单每条含目标文件/具体改法/工作量/验收方式（第三章）、影响范围与风险（第四章）、落地顺序建议（第六章）。
- 本轮不实施任何代码改动；实施时按「P0 一个迭代单元 → 全页视觉巡检 → P1 一个迭代单元 → 巡检」推进。

---

## 六、落地顺序建议

1. **迭代一（P0）**：StatCard 模板 → 图表色板常量 → Badge 重构；一次提交，浏览器巡检 dashboard/costs/hr/admin 四域指标卡 + 任一列表状态色。
2. **迭代二（P1）**：Layout 顶栏/品牌区 → PageShell actions → FilterBar → empty 接入；一次提交，全页导航与布局回归巡检。
3. **可选（P2）**：按用户反馈逐项决定，字体梯度最优先（成本最低、全局受益）。
4. 与既有计划的关系：本方案对应 go-live 文档第五章的后续深化——G1-G4 解决「规范一致性」，本方案解决「设计质感」；M1（多维表格同步）/M2（多环境）等工程里程碑不受影响，可并行排期。
