# 晟笙 ERP

晟笙数据服务的一体化经营系统，版本 **2.4.0**。合同、项目、采购、成本、收入、应收应付、总账和报表在同一套账上运转，单据按**纳税主体**归属开票、计税和结账。

运行时要求 **Node.js 22**（见 `.nvmrc`）和 **PostgreSQL 16**。仓库地址：<https://github.com/cherry6611/CS-ERP>（私有）。

这份文档给要跑起来、要改代码、要核对账的人。排障步骤、备份回滚和发布检查的操作细节在 [docs/RUNBOOK.md](docs/RUNBOOK.md)。某个后端模块的表、接口和状态机，以该目录下的 `README.md` 为准。

## 目录

- [系统在解决什么](#系统在解决什么)
- [角色与能看见的菜单](#角色与能看见的菜单)
- [从一笔业务走到报表](#从一笔业务走到报表)
- [各模块怎么用](#各模块怎么用)
- [技术结构](#技术结构)
- [仓库目录](#仓库目录)
- [本地开发](#本地开发)
- [用 Docker 跑](#用-docker-跑)
- [登录、密码与双因素](#登录密码与双因素)
- [账怎么取、税怎么算](#账怎么取税怎么算)
- [环境变量](#环境变量)
- [命令](#命令)
- [定时任务](#定时任务)
- [改代码时要守的约定](#改代码时要守的约定)

## 系统在解决什么

数据服务公司的经营数据以前散在表格、聊天记录和飞书文档里：合同金额对不上项目预算，开票税率不知道跟哪家主体，成本和回款要月底再对一次表。晟笙 ERP 把这些收成一条链：

1. 先有**纳税主体**（哪家公司开票、用什么默认税率、一般纳税人还是小规模）。
2. 客户、线索、商机、报价落在 CRM，成交后变成**合同**。合同记下计费模式、含税金额、税率和归属主体。
3. 合同生效后**立项**。里程碑、交付物、工时、采购、成本、收入都挂在项目上。
4. 开票、应收、回款、应付、付款在财务模块核销。业务动作同时生成**凭证草稿**。
5. 凭证过账后，账簿和三张报表按期间取已过账分录。期末做增值税申报底稿和年结。

侧栏按人要完成的任务分组，不按后端文件夹分组。例如供应商放在「采购与资产」，纳税主体、审计、设置放在底部「系统」。

| 分组 | 入口 | 路径 | 进入所需能力 |
|---|---|---|---|
| 工作台 | 经营看板 | `/` | `dashboard` |
| 工作台 | 指标中心 | `/bi/metrics` | `dashboard` |
| 客户与合同 | 客户管理 | `/customers` | `crm` |
| 客户与合同 | 线索与商机 | `/crm` | `crm` |
| 客户与合同 | 合同管理 | `/contracts` | `crm` |
| 项目交付 | 项目管理 | `/projects` | `projects` |
| 项目交付 | 成本核算 | `/costs` | `projects` |
| 项目交付 | 收入确认 | `/revenue` | `finance` |
| 采购与资产 | 采购管理 | `/pur` | `pur_asset` |
| 采购与资产 | 供应商管理 | `/suppliers` | `crm` |
| 采购与资产 | 退货管理 | `/returns` | `finance` |
| 采购与资产 | 固定资产 | `/asset` | `pur_asset` |
| 财务 | 应收应付 | `/finance` | `finance` |
| 财务 | 票据管理 | `/notes` | `finance` |
| 财务 | 预算费控 | `/fin-expense` | `finance` |
| 财务 | 总账凭证 | `/voucher` | `finance` |
| 财务 | 财务报表 | `/finance/reports` | `finance` |
| 财务 | 会计账簿 | `/finance/ledgers` | `finance` |
| 财务 | 税务申报 | `/finance/tax-declaration` | `finance` |
| 财务 | 期末年结 | `/finance/year-end` | `finance` |
| 人力与行政 | 人力资源 | `/hr` | `hr` |
| 人力与行政 | 租房合同 | `/admin-rent` | `admin_ops` |
| 人力与行政 | 行政缴费 | `/admin-bills` | `admin_ops` |
| 人力与行政 | 行政资产 | `/admin-assets` | `admin_ops` |
| 人力与行政 | 车辆与差旅 | `/admin-affairs` | `admin_ops` |
| 企业文档 | 云空间 | `/drive` | `drive` |
| 企业文档 | 知识库 | `/wiki` | `drive` |
| 系统 | 纳税主体 | `/masterdata/tax-entities` | `tax_entity` |
| 系统 | 自动化任务 | `/admin-automation` | `admin_ops` |
| 系统 | 审计日志 | `/audit` | `audit` |
| 系统 | 数据资产 | `/data-asset` | `data_asset` |
| 系统 | 设置 | `/settings` | `settings_appearance` |

手输 URL 进入子页面（例如 `/contracts/new`、`/projects/:id`）时，按**最长前缀**套用上表的能力。匹配不到的路径直接拒绝，不会因为「表里没写这条路由」就放行。实现在 `shared/rbac.ts` 的 `resolveRouteCapability`。

顶栏「搜索」和「新建」打开同一个命令面板（`⌘K` / `Ctrl K`）。快捷操作会进入对应的新建页：新建线索、新建商机、新建合同、项目立项、登记发票。其余条目用于跳转已有页面。

## 角色与能看见的菜单

角色定义在 `shared/rbac.ts`，前后端共用这一份矩阵。`admin` 拥有全部能力。

| 代码 | 名称 | 实际能做的事 |
|---|---|---|
| `admin` | 超级管理员 | 全部菜单，含纳税主体维护、自动化任务、审计、数据资产、品牌与飞书配置 |
| `user_admin` | 账号管理员 | 开通账号、分配角色、重置密码、踢会话、绑定飞书。能看人力，不能改薪酬业务数据 |
| `hr_manager` | 人事经理 | 员工档案、考勤、薪酬、招聘、绩效、培训的读写 |
| `finance_viewer` | 财务只读 | 能看财务、纳税主体、客户合同、项目、采购资产。不能过账、不能改凭证、不能核销 |
| `project_manager` | 项目经理 | 项目与成本的读写；客户合同、采购资产只读 |
| `drive_editor` | 云文档编辑 | 云空间、知识库可写；其余业务菜单按默认规则，多数只读或不可见 |

读和写是两套能力码。矩阵里某个域写成 `rw`，只表示**能打开页面**；真正落库要再有对应的 `*_write`。例如 `finance_viewer` 对 `finance` 是 `r`，对 `finance_write` 没有权限，所以按钮会 403。

任意已登录用户（含还没分配角色的账号）都有 `self_service`：改自己的密码、绑定自己的 MFA、撤销自己的会话、上传自己单据的附件、填自己的工时和请假。对象是不是「本人」在服务层再查一次，不靠前端藏按钮。

数据还有行级范围（`sys_data_scope`）：

- `all`：不额外过滤。
- `self`：只看自己负责或参与的项目等。
- `dept` / `dept_and_child`：按部门过滤。
- 规则要求收窄、但取不到可用值：返回空集（`DATA_SCOPE_UNCONFIGURED_POLICY` 默认 `fail_closed`）。生产不要改成 `allow`。

数据资产（数据集、授权、脱敏）目前**只有 admin**。这个模块还没有按合同做行级过滤，一旦放开就会看到全部合同下的数据集。

## 从一笔业务走到报表

下面是一条完整路径。每一步都写了页面、前置条件和做完之后系统里多了什么。

### 1. 纳税主体

路径：`/masterdata/tax-entities`。客户页、合同页、开票页在主体库为空时会提示「去创建」，链到这个地址。

新建时要填编码、名称、统一社会信用代码、纳税人类型（一般纳税人 / 小规模）、默认销项税率、默认进项税率。可以指定默认主体，全局只允许一个 `is_default`。税率是**百分数**：填 `6` 表示 6%，填 `0.06` 会被当成 0.06%。

主体不能删除，只能停用。增值税申报底稿按 `tax_entity_id` 分组，删掉主体后历史底稿对不上。停用前先确认没有未结单据还拿它当开票来源。

实际开票税率的优先级：合同上的 `tax_rate`，其次才是主体的默认销项/进项税率。

### 2. 客户、线索、商机

- 客户：`/customers`。档案含行业、信用代码、信用等级、信用额度、账期、关联主体和默认税率。可导入、导出 Excel。停用后不能再被新合同引用。
- 线索：`/crm` 的「线索管理」，新建页 `/crm/leads/new`。保存后进入详情，可补需求文档和跟进。
- 商机：同一页的「商机管理」，新建页 `/crm/opportunities/new`。挂客户、预计金额、赢单率。详情里维护多轮报价。
- 报价可从飞书多维表格导入，表标识是 `FEISHU_BITABLE_QUOTATION_TABLE`。

客户信用有每日扫描：超额度或接近上限时提醒管理员。

### 3. 合同

新建页：`/contracts/new`。必填合同名称、客户、计费模式、含税金额。计费模式有项目制、按量计费、订阅制、框架合同。税率档位与不含税金额、税额在表单里即时拆分。还可填签订日、起止日期、负责人、付款条款，以及归属的纳税主体。

保存后进入详情，继续维护：

- 合同明细
- 里程碑
- 变更
- 附件

合同进入 `active` / `performing` 后，其不含税净额会进入预算的「承诺」层（已经签出去、还没花掉的钱）。同合同下项目全部结项时，合同回写成 `completed`。

可选：`AUTO_CREATE_PROJECT=1` 时，合同生效会自动建对应项目；不设则必须到项目页手工立项。

### 4. 立项与交付

新建页：`/projects/new`。关联合同，可选最终成交报价单（不指定则系统按规则匹配）、项目经理、部门、预算基线、预计总成本、起止日期。

项目状态：

```
draft → active → accepting → closed
              ↘ suspended ↗
任意非终态 → cancelled
```

结项三个条件缺一不可，否则接口 400：

1. 全部交付物已验收（`accepted`）。
2. 全部里程碑已达成（`reached`）。
3. 结项说明 `closeSummary` 非空。

交付物自己的状态是 `pending → submitted → accepted | returned`。

进度：有加权里程碑时，进度 = 已达成权重 / 总权重；没有权重的项目保持手工进度，避免历史数据被改写。挣值用里程碑权重法算 SPI / CPI / EAC；分母为 0 时返回空，而不是 0（0 会被看成严重滞后）。

项目列表和详情受数据范围过滤。负责人、成员、部门对不上的人打开详情会看到空，而不是别人的项目。

### 5. 成本、工时、收入

成本页 `/costs` 有五个页签：

| 页签 | 内容 |
|---|---|
| 成本归集 | 按项目、成本类型、含税金额、来源摘要入账，可指定我方纳税主体 |
| 工时登记 | 员工在项目上的工时 |
| 角色费率 | 不同角色的小时费率，供工时折算成本 |
| 公共分摊 | 把公共费用分到项目 |
| 多维分析 | 按项目、类型、期间看成本 |

收入页 `/revenue` 有三个页签：收入台账、未开票收入、收入调整。确认收入时选择项目、确认方式、期间和含税金额。指标中心里的「营业收入」用的是已确认收入的**不含税净额**（`金额 × 100 / (100 + 税率)`）再加上已生效调整。

### 6. 采购、供应商、退货、资产

采购页 `/pur`：

- 采购申请：标题、类型、预算金额、部门、项目、意向供应商、期望到货日。
- 采购订单：由申请转订单，验收后才能退货。
- 采购看板：看申请和订单的状态分布。

订单状态属于 `approved` / `ordered` / `accepted` 时，订单含税金额计入预算「承诺」。

退货页 `/returns` 分采购退货和销售退货。采购退货的可退数量 = 已验收 − 已退。没验收的货不能退，应催货或取消订单。退货单先落草稿，批准并完成后才生成红字凭证（冲应付、原材料和进项税）。销售退货红冲收入和应收。

固定资产 `/asset` 的页签：资产台账、折旧计提、减值测试、处置报废、变更审批、生命周期。

- 资产状态在 `in_use`、`idle`、`repair` 之间转换；处置完成变成 `disposed` 或 `scrapped`。
- 折旧用年限平均法，按月计提，并归集到项目成本、生成凭证。累计折旧**没有**存在资产卡片上，必须从 `ast_depreciation` 汇总。
- 同一资产同时只允许一张进行中的处置单，避免重复出凭证。
- 减值走备抵科目，不改固定资产原值。

### 7. 应收、应付、发票、票据

应收应付 `/finance` 的页签：

| 页签 | 做什么 |
|---|---|
| 应收与回款 | 登记应收、登记回款、回款核销 |
| 应付与付款 | 登记应付、付款申请与核销 |
| 发票登记 | 销项或进项。新建页 `/finance/invoices/new`，保存后上传扫描件 |
| 勾稽中心 | 三条链：销售对应收、采购对应付、回款对核销 |
| 对账单 | 与客户或供应商对账 |
| 账龄分析 | 未到期、1–30、31–60、61–90、90 天以上 |
| 现金流 | 13 周滚动预测，周界按业务时区的周一 |

核销用行级锁防止并发下超额核销。发票状态为 `issued` 才进入「本期净开票额」。查验服务默认不接第三方（`INVOICE_VERIFY_PROVIDER=none`），页面上人工核对。

票据 `/notes`：登记银行承兑或商业承兑，记录持有、背书、贴现、到期收款、拒付。贴现息 = 票面 × 贴现率 / 100 × 贴现天数 / 360，天数算头不算尾。备查簿按状态和票据类型汇总。

### 8. 预算与报销

预算费控 `/fin-expense`：

| 页签 | 含义 |
|---|---|
| 预算 | 按部门、项目、费用科目、期间（`YYYY-MM`）做预算行。部门或项目为空表示这一维不限制 |
| 三算对比 | 预算、承诺、实际。承诺是已经签下但还没花的钱 |
| 全面预算 | 跨期间、跨部门的汇总 |
| 费用申请 | 提交时预占预算 |
| 报销单 | 审批通过后计入实际，并可以联动应付和项目成本 |

承诺从哪来：

| 来源 | 计入条件 | 金额 |
|---|---|---|
| 采购订单 | 已批准、已下单或已验收 | 含税金额 |
| 合同 | 生效中或履约中 | 不含税净额 |
| 费用申请 | 审批中 | 申请金额，算承诺 |
| 费用申请 | 已批准 | 算实际，不再算承诺 |
| 报销单 | 已批准 | 算实际 |

同一张单据只计一次。合同没有项目列，所以合同承诺不进「按项目」那一维，项目级承诺靠采购订单和费用申请。

### 9. 凭证、账簿、报表

总账 `/voucher`：

- 凭证：手工新增，或等业务事件自动生成草稿。状态 `draft → posted`，任何状态都可作废为 `voided`。作废凭证不进任何账簿和报表。
- 科目表：多级科目。只有末级（`is_leaf = 1`）能直接做账。模板里写的语义编码（如 `1002`）会下钻到末级（如 `100201`）。
- 期间：结账后该期间只读。反结账要求不存在更晚的已结账期间。

草稿凭证的摘要可以改。已过账的要改，只能作废再重开，保证账证相符。

业务成功但凭证生成失败时，写入 `comp_voucher_job`（同一来源单据只入队一次）。每 10 分钟重试，最多 8 次。次数用尽或状态变成 `dead` 后要人工补录，不要删源单据。队列数字在「自动化任务」页，接口 `GET /api/admin/voucher-jobs`。

会计账簿 `/finance/ledgers`：科目余额表、总账、明细账、辅助余额表、组合与分摊。试算平衡：

```bash
curl -s "http://127.0.0.1:3000/api/finance/ledgers/trial-balance?period=2026-10"
```

财务报表 `/finance/reports`：资产负债表、利润表、现金流量表。行和公式存在 `fin_report_template`，改口径用迁移改模板，不必发版。公式 DSL 支持 `科目余额`、`科目发生`、`期初余额`、`科目变动`、`行`、`上期`、四则运算。现金流量表用间接法。

出报表前看接口返回的 `checks`。不平衡时页头告警。三条恒等式：

1. 资产总计 = 负债和所有者权益总计。
2. 净利润 = 利润总额 − 所得税费用。
3. 期初现金 + 现金净增加额 = 期末现金 = 资产负债表货币资金。

对不上时按这个顺序查：有没有未过账草稿、有没有把作废凭证算进去、凭证日期和期间是否跨月、分录是否挂在非末级科目、该年度是否已经年结。

### 10. 税务申报与年结

税务申报 `/finance/tax-declaration`：按期间、按纳税主体，把发票台账口径和总账口径放在一起。未选具体主体时，附加税费无法按主体计提，页面会提示。两边有差异时，确认底稿必须填写差异原因。确认后留痕，底稿在 `fin_vat_declaration`。

期末年结 `/finance/year-end`：先选期间和主体，看收入合计、费用合计、净利润，以及前置校验。没有损益发生额时状态是「不可结转」，这是预期结果，不是故障。执行年结会在事务里生成结转凭证。年结后该年度期间只读。

反年结：`POST /api/finance/year-end/:fiscalYear/reverse`，正文里 `reason` 至少 4 个字，且 `approved` 为 `true`。系统作废结转凭证并写入 `fin_year_end_log`，这条留痕不能删。

### 11. 人力与行政

人力资源 `/hr` 的页签：人力看板、身份管理、员工档案、考勤与请假、薪酬管理、招聘管理、绩效考核、培训管理、我的。

- 身份管理管的是**能登录的账号**（`sys_user`）：开通、分配角色、重置密码、代绑飞书、停用、踢掉会话。员工档案（`md_employee`）是另一张表，通过 `platform_user_id` 和账号相连。
- 未绑定飞书的人不能靠飞书回调自动注册。顺序是：先有账号，再到设置里绑定飞书，之后才能飞书登录。
- 薪酬用累计预扣预缴法。累计应纳税所得额 = 累计收入 − 累计免税收入 − 5000 × 月份 − 累计专项扣除 − 累计专项附加扣除 − 累计其他扣除。本期税额不为负；多扣记 `refundable`，不自动退税。
- 社保按城市规则 `hr_ss_city_rule` 的基数上下限夹取。某个期间找不到匹配规则时接口返回 400，禁止悄悄用一条过期比例。
- 员工自助「我的」只看本人档案、考勤、假期余额和工资单，可提交请假和补卡。

行政四块都只有管理员能写：

- 租房合同：地址、出租方、月租金、押金、起止租期、付款方式、我方主体。
- 行政缴费：房租、物业、水电。状态从草稿到提交、审批、付款。
- 行政资产：办公设备和家具，和财务固定资产卡片不是同一张表。
- 车辆与差旅：用车和差旅登记、费用结清。

租约到期、应收到期等提醒见文末定时任务。

### 12. 文档、审计、数据资产、设置

云空间 `/drive` 和知识库 `/wiki` 读飞书。未配置根目录 token 或知识库空间 ID 时，页面说明缺什么、写操作禁用，其他业务不受影响。配置可以写在环境变量，也可以在「设置 → 外观与集成」写入数据库。

审计日志 `/audit` 只追加。每条按插入顺序串校验和；改一行，后面的链都会失配。数据库触发器拒绝普通 `UPDATE`，`DELETE` 只允许带归档标记的清理。页面上可以跑「校验链」和「只追加自检」。审计和登录审计的保留策略不允许设成物理删除。

数据资产 `/data-asset`：数据集目录、授权记录、脱敏与回收审计。新建数据集时填名称、来源、脱敏等级、关联合同。

设置 `/settings` 三个页签：

- 外观与集成：主题、密度、品牌名和 Logo、报价多维表格、飞书云空间与知识库、绑定飞书。
- 字典设置：成本类型、费用类别、发票类型、税率档位等。内置项不能删，只能停用。被业务引用的自定义项也不能删。
- 参数设置：审批阈值、密码有效期、登录锁定、附件上限等。`editable = 0` 的参数是口径红线，界面只读，接口也会拒绝修改。

## 技术结构

| 层 | 实现 |
|---|---|
| 页面 | React 19、Vite 7、React Router、Tailwind CSS 4。列表多用 Ant Design Table，表单和对话框用项目内的组件 |
| 接口 | NestJS 10 + Express。控制器声明登录和读写能力，业务在 service |
| 数据库 | PostgreSQL 16。表结构用 Drizzle 描述在 `server/database/schema.ts`，变更用 `server/database/migrations/*.sql` |
| 会话 | JWT 放 HttpOnly Cookie。`JWT_SECRET` 签名。改密或重置密码会撤销该用户全部会话 |
| 机密 | MFA 密钥等用 `SECRET_ENC_KEY` 做 AES-256-GCM（`enc1:` 前缀），不明文落库 |
| 集成 | 飞书 OAuth、通讯录、云空间、知识库、多维表格、事件订阅。未配置时对应功能降级，进程仍能启动 |
| 部署 | 一个容器：迁移后启动 Nest，由 Nest 托管 `dist/client`。对外只经过 HTTPS 反代 |

请求路径：浏览器打开 Vite（开发）或 Nest 静态页（生产）→ `/api/*` 进入控制器 → `RolesGuard` 用 `shared/rbac.ts` 判断读写 → service 再套数据范围和状态机 → PostgreSQL。写操作经审计拦截器记入只追加日志。

金额计算用 `shared/number.ts`。不要在页面或服务里用 JavaScript 浮点直接做加减。税率拆分用 `shared/tax.ts` 的 `splitTax(含税金额, 百分数税率)`。

`NODE_ENV` 不是 `development` 时按生产标准执行：弱密钥拒绝启动，异常不回显堆栈，`FEISHU_ALLOW_UNVERIFIED_EVENTS` 即使写成 true 也会被忽略。

## 仓库目录

```
client/                 前端
  src/pages/            按业务分的页面。对话框多在各页 components/
  src/api/              按模块封装的请求
  src/components/       布局、命令面板、表格操作组、帮助气泡、通用 UI
  src/platform/         登录态、主题、能力判断
server/
  modules/              一个业务域一个目录，多数带 README.md
  database/migrations/  按文件名排序执行的 SQL
  database/schema.ts    Drizzle 表定义
  common/               权限、税务解析、金额、安全（TOTP、密钥箱）
  platform/             数据库、守卫、启动
shared/                 rbac.ts、api.interface.ts、number.ts、tax.ts
scripts/                启动、构建、迁移、检查、备份、演练
docs/RUNBOOK.md         运维排障
docker-compose.yml      Postgres 16 + 应用
Dockerfile              多阶段构建，运行用户为 node
.env.example            环境变量说明。复制成 .env，不要提交 .env
```

后端模块对照：

| 目录 | 负责 |
|---|---|
| `auth` | 密码登录、飞书 OAuth、MFA、锁定、登录审计 |
| `identity` | 账号、角色、重置密码、会话、飞书绑定 |
| `master-data` | 客户、供应商、联系人 |
| `tax` | 纳税主体 |
| `crm` | 线索、商机、报价 |
| `contracts` | 合同、明细、变更、合同侧里程碑 |
| `projects` | 立项、里程碑、交付物、变更、结项、挣值、项目可见范围 |
| `costs` | 成本归集、工时、费率、分摊 |
| `revenues` | 收入确认与调整 |
| `pur` | 采购申请、订单、验收 |
| `returns` | 采购退货、销售退货 |
| `asset` | 固定资产卡片、折旧、减值、处置 |
| `finance` | 应收应付、发票、核销、勾稽、现金流、外协结算 |
| `notes` | 承兑汇票 |
| `fin-expense` `fin-budget` | 费用申请、报销、预算与三算 |
| `voucher` | 科目、凭证、期间、失败重试 |
| `finance-reports` | 三张报表、账簿、年结、增值税底稿 |
| `hr` | 员工、考勤、薪酬、招聘、绩效、培训、员工自助 |
| `admin` | 租房、缴费、行政资产、差旅、定时任务开关 |
| `bi` | 看板与指标注册表、预警订阅 |
| `feishu-drive` `feishu-sync` `feishu-collab` | 云空间、知识库、通讯录与多维表格 |
| `audit` | 审计日志与校验链 |
| `data-asset` | 数据集与授权 |
| `system-config` | 字典、参数、编号规则、保留策略 |
| `files` `attachment` | 上传、扫描、附件权限 |
| `notifications` | 站内信 |
| `health` | `/api/health` |
| `view` | 生产环境托管前端静态文件 |

## 本地开发

### 1. 安装

安装 Node.js 22 和 PostgreSQL 16。在仓库根目录：

```bash
npm install
cp .env.example .env
```

Windows 没有 `cp` 时，复制 `.env.example` 为 `.env` 即可。

### 2. 数据库

本地开发库建议单独实例，端口 **5433**，避免和本机默认的 5432、以及 Compose 的 5434 抢端口。`.env` 示例：

```
DATABASE_URL=postgresql://erp:你的密码@127.0.0.1:5433/shengseerp
JWT_SECRET=至少 32 字节的高熵字符串
SECRET_ENC_KEY=至少 16 位的高熵字符串
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=至少12位且含大小写数字符号
```

然后：

```bash
npm run db:migrate
```

迁移按文件名排序，包在事务里。失败则整段回滚，且不会记入 `schema_migrations`。想先确认迁移链本身没有问题、又不想碰真实库：

```bash
npm run migrate:dryrun
```

它在 pglite（WASM 版 PostgreSQL）上从头跑一遍。

新增迁移的文件名必须排在它依赖的建表脚本**之后**。已经在库里执行过的文件不要改名，改名会被当成新脚本再执行一次。DDL 要幂等（`IF NOT EXISTS`，或捕获 `duplicate_object`）。

### 3. 启动

```bash
npm run dev
```

这条命令同时拉起：

- Nest（`nest start --watch`）：<http://127.0.0.1:3000/api>
- Vite：<http://127.0.0.1:5173/>

Vite 把浏览器里的 `/api` 代理到 3000。请用 `127.0.0.1` 打开页面，不要和 `localhost` 混用。飞书 OAuth 的 state Cookie 按主机名隔离，两个名字会被当成两个站点。

```bash
curl -s http://127.0.0.1:3000/api/health
```

`ok` 和 `db` 都为 `true` 即数据库可用。`version` 来自 `GIT_SHA`，未设置时是 `dev`。

首次启动若库里没有管理员，会用 `BOOTSTRAP_ADMIN_*` 创建。日志里出现「已创建初始账号」后，登录、改密、完成 MFA，然后**删掉** `.env` 里的 `BOOTSTRAP_ADMIN_PASSWORD`。否则每次重启都还会走一遍初始化逻辑。

本地定时任务会真的跑。不需要提醒和同步时设 `ENABLE_SCHEDULER=false`。

### 4. 登录

打开 <http://127.0.0.1:5173/login>。

1. 输入账号和密码。账号不存在和密码错误是同一句提示，避免被人探出账号是否存在。
2. 角色要求 MFA 但还没绑定：页面展示密钥、otpauth 链接和一组恢复码。恢复码只显示这一次，库里只存哈希。用认证器上的 6 位码确认绑定，然后重新登录。
3. 已经绑定：再输入 6 位动态码。校验票据一次性，用过即失效。
4. 连续失败 5 次，该账号锁定 15 分钟。锁定按账号计，不按 IP，避免公司 NAT 把所有人锁在外面。

`admin`、`user_admin`、`finance_viewer` 默认强制 MFA。

## 用 Docker 跑

`docker-compose.yml` 有两个服务：

- `postgres`：镜像 `postgres:16`，数据卷 `erp-pg`，端口只绑 `127.0.0.1:${POSTGRES_HOST_PORT:-5434}`。
- `app`：构建本仓库 Dockerfile。启动命令是先 `node scripts/db-migrate.mjs`，再 `node dist/server/main.js`。端口只绑 `127.0.0.1:3000`。

`.env` 里至少准备 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`JWT_SECRET`、`SECRET_ENC_KEY`。容器内的 `DATABASE_URL` 指向服务名 `postgres`，不要把宿主机的 `127.0.0.1:5433` 写进容器，否则容器连不上库、迁移失败、进程起不来。

```bash
docker compose up -d --build
curl -s http://127.0.0.1:3000/api/health
```

生产构建也可以不经 Compose，在装好依赖和 `.env` 的机器上：

```bash
npm run build
npm start
```

`dist/client/index.html` 不存在时，站点根路径返回 500。生产前面应有 HTTPS 反代，并把 `TRUST_PROXY_HOPS` 设为 `1`。应用直接暴露在 3000、没有反代时保持 `0`，否则客户端可以伪造 `X-Forwarded-For`。

生产不要设 `COOKIE_SECURE=false`。该值为 false 时，浏览器在 HTTPS 下仍可能按不安全 Cookie 处理；在纯 HTTP 演示环境才需要它，否则会话 Cookie 根本存不住。

镜像以用户 `node` 运行，上传目录是 `/app/data/uploads`（卷 `erp-uploads`）。内存限制 1 GB。

## 登录、密码与双因素

默认策略（可在 `sys_param` 调整，键名见 `server/modules/auth/README.md`）：

| 项 | 默认 |
|---|---|
| 密码长度 | 至少 12 |
| 复杂度 | 大写、小写、数字、符号都要有 |
| 轮换 | 90 天 |
| 历史 | 最近 5 次不能复用 |
| 锁定 | 连续 5 次失败，锁 15 分钟 |
| 恢复码 | 8 个，格式 `XXXX-XXXXX`，只在生成时显示一次 |
| TOTP | 30 秒一步，6 位，允许前后各一个时间窗 |

改密、被管理员重置密码之后，该用户全部会话作废。JWT 本身无状态，不撤会话的话旧 Cookie 仍然有效。

登录相关接口：

| 方法 | 路径 |
|---|---|
| POST | `/api/auth/login` |
| POST | `/api/auth/mfa/verify` |
| POST | `/api/auth/mfa/setup`、`/mfa/confirm`、`/mfa/disable` |
| POST | `/api/auth/password/change` |
| GET | `/api/auth/me` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/feishu/start`、`/bind`、`/callback` |
| GET | `/api/auth/sessions` |
| POST | `/api/auth/sessions/:jti/revoke` |

账号管理在人力页的「身份管理」，接口前缀 `/api/identity/users`，能力码 `identity`（admin 与 `user_admin`）。

## 账怎么取、税怎么算

取已过账凭证，排除 `voided`。期间等于凭证日期的前 7 位（`YYYY-MM`），两者不一致就是跨期。非末级科目不能直接挂分录。

年结之后，该年度所有期间只读。要改账必须先反年结。

增值税：

- 申报底稿同时给出发票台账口径和总账口径。
- 未指定主体时不算附加税费。
- 勾稽不一致仍要确认时，必须写差异原因。
- 主体停用而不是删除，历史底稿才能继续按主体汇总。

固定资产分录的不变量（测试锁定）：每笔记账借贷相等；固定资产清理科目在完整处置分录里轧差为 0；减值不改原值，走减值准备。

工资个税按国家税务总局 2018 年第 61 号公告的累计预扣预缴。连续 12 个月发放时，累计已预扣应等于全年应纳税额，这条由单测固定。社保在没有当期城市规则时失败，不回落。

编号规则在 `sys_code_rule`：前缀、日期段、流水位数、按年或按月重置。凭证、发票、回款、付款、工资、应收、应付这些类型**禁止重用编号**，打开「允许重用」会 400。

## 环境变量

全部键和注释在 `.env.example`。下面按用途分组，值不要写进仓库。

**必填**

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 开发机指向本机库。容器内由 Compose 改写为 `postgres:5432` |
| `JWT_SECRET` | 会话签名。生产用长随机串，弱值拒绝启动 |
| `SECRET_ENC_KEY` | 应用层加密密钥，至少 16 位 |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | 仅 Compose 创建数据库时使用 |

**首次管理员**

| 变量 | 说明 |
|---|---|
| `BOOTSTRAP_ADMIN_USERNAME` | 默认 `admin` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 满足密码策略。创建成功后从环境中删除 |

**服务**

| 变量 | 说明 |
|---|---|
| `SERVER_HOST` / `SERVER_PORT` | 默认 `0.0.0.0` 和 `3000` |
| `APP_BASE_URL` | 用户浏览器里的站点根。飞书回调落地必须和它同一主机 |
| `CLIENT_BASE_PATH` | 前端基础路径，默认 `/` |
| `TRUST_PROXY_HOPS` | 无反代为 `0`，一层 Nginx/SLB 为 `1` |
| `COOKIE_SECURE` | 生产留空。仅本地 HTTP 演示可 `false` |
| `CORS_ORIGIN` | 浏览器来源和 `APP_BASE_URL` 不同源时，逗号分隔列出 |
| `NODE_ENV` | 生产镜像里是 `production` |
| `ENABLE_SCHEDULER` | `false` 关闭全部定时任务 |
| `GIT_SHA` | 写进健康检查，用来确认线上是哪次构建 |
| `LOG_DIR` | 设置后额外把 JSON 日志写入该目录 |
| `UPLOAD_DIR` | 默认 `data/uploads`。导出文件默认在其下 `exports`，也可用 `EXPORT_DIR` 分开 |
| `PER_REQUEST_TX` | 默认 `connection`。不要为了省连接改成 `transaction`，除非明确在做只读压测 |
| `ALLOW_WEAK_SECRETS` | 仅本地。生产不要设 |
| `DATA_SCOPE_UNCONFIGURED_POLICY` | 默认 `fail_closed` |
| `AUTO_CREATE_PROJECT` | `1` 表示合同生效时自动立项 |

**飞书**

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 自建应用 |
| `FEISHU_REDIRECT_URI` | 与开放平台「重定向 URL」逐字相同，开发用 `http://127.0.0.1:3000/api/auth/feishu/callback` |
| `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` | 事件订阅。生产缺失时事件接口全部拒绝 |
| `FEISHU_ALLOW_UNVERIFIED_EVENTS` | 仅本地联调。生产会被代码忽略 |
| `FEISHU_FALLBACK_RECEIVER` | 收件人没绑飞书时的兜底 open_id。只发标题，不发正文 |
| `FEISHU_BITABLE_APP_TOKEN` 及 `*_TABLE` | 成本、合同、工时、报价表 |
| `FEISHU_ROOT_FOLDER_TOKEN` | 云空间根目录 |
| `FEISHU_WIKI_SPACE_ID` | 知识库空间 |

**可选集成**

| 变量 | 说明 |
|---|---|
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | 报价单解析。空着不影响启动 |
| `FILE_SCAN_PROVIDER` | `none`（默认）、`clamav`、`http`。`http` 时还要 `FILE_SCAN_URL` 和 `FILE_SCAN_TOKEN` |
| `INVOICE_VERIFY_PROVIDER` | `none` 或 `http-vendor` |
| `SWAGGER_ENABLED` | 默认 `false`。设为 true 时必须同时给 `SWAGGER_USER` 和 `SWAGGER_PASSWORD` |

## 命令

```bash
npm run dev                  # Nest watch + Vite
npm run dev:server           # 只起后端
npm run dev:client           # 只起 Vite
npm run db:migrate           # 应用未执行的迁移
npm run migrate:dryrun       # 在 pglite 上排练整条迁移链
npm run build                # 服务端 + 前端
npm start                    # 迁移后启动生产进程

npm test                     # Jest
npm run test:cov             # 带覆盖率
npm run type:check           # server / client / scripts / specs 四路并行
npm run lint
npm run eslint
npm run stylelint

npm run check:rbac           # 能力码是否在矩阵内、写接口是否误用只读装饰器、控制器是否缺登录
npm run check:rbac:frontend  # 前端路由和能力码
npm run check:contract       # 接口契约
npm run check:need-login
npm run check:migration-headers
npm run check:enum-whitelist
npm run check:numeric-precision
npm run check:biz-timezone
npm run check:label-dict
npm run check:audit-immutability
npm run preflight            # 发布前把上面几类检查串起来

npm run gen:openapi          # 生成 OpenAPI
npm run drill:backup         # 备份与恢复演练
npm run drill:perf           # 性能演练，会读 .env 里的引导账号
node ./scripts/backup-db.mjs
node ./scripts/restore-db.mjs <备份文件>
```

单个模块的测试可以收窄，例如：

```bash
npx jest --config jest.config.cjs server/modules/finance-reports
npx jest --config jest.config.cjs server/modules/auth server/common/security
```

恢复数据库之后，把 [账怎么取、税怎么算](#账怎么取税怎么算) 里的三条恒等式再跑一遍。只看到进程起来不算恢复成功。

## 定时任务

开关在 `/admin-automation`，行存在 `comp_automation_config`。时区 `Asia/Shanghai`。多实例部署时，同一任务用 `pg_try_advisory_xact_lock` 保证只有一个实例执行。`ENABLE_SCHEDULER=false` 全部停掉。

| 键 | 周期 | 做什么 |
|---|---|---|
| `ar_due_reminder_daily` | 每天 09:00 | 状态为 open、到期日在今天到未来 7 天内的应收。按回款责任人分组；没有责任人则发给 admin |
| `delivery_warning_weekly` | 每周一 09:00 | 已逾期或 7 天内到期的里程碑，以及 SPI/CPI 低于 0.9 的项目 |
| `customer_credit_alert` | 每天 09:00 | 超过信用额度或接近上限的客户 |
| `admin_rent_expiry_remind` | 每天 09:00 | 即将到期的租房合同 |
| `bi_alert_daily` | 每天 08:30 | 按用户在指标中心订阅的阈值扫描 |
| `voucher_job_retry` | 每 10 分钟 | 重试 `comp_voucher_job`，最多 8 次 |
| `session_cleanup_daily` | 每天 03:15 | 清理过期会话 |
| `retention_daily` | 每天 03:30 | 按保留策略归档，并清理过期的 MFA 挑战票据 |
| `year_end_reminder_daily` | 每天 09:00 | 12 月 20 日起提醒年结前置检查 |
| 合同到期 | 每天 09:15 | 生效中或履约中的合同，在 30 / 15 / 3 天到期时按负责人合并通知 |
| 飞书通讯录与多维表格 | 见任务说明 | 全量、增量同步，以及项目文档同步。未配置飞书时任务应保持关闭 |

页面上每个任务有独立开关。停用后到点不执行。凭证补偿队列的待重试、处理中、失败、dead 四个数在同一页上方。

## 改代码时要守的约定

- 新接口先 `@NeedLogin`，再按语义加 `@CanCapability` 或 `@CanCapabilityRead`。写操作用只读装饰器会被 `check:rbac` 拦住。
- 能力码只能取 `shared/rbac.ts` 里已有的。侧栏写错一个码，菜单项会消失且不报错。
- 新页面路径要登记进 `NAV_CAPABILITY`，否则最长前缀匹配失败，用户看到无权限。子路径会继承父路径，例如 `/projects/new` 使用 `projects`。
- 控制器里的请求体 class 要定义在控制器类**之前**，否则 TypeScript 的暂时性死区会在运行时炸掉。
- 字典改完要让缓存失效，否则另一个实例还会读 60 秒内的旧值。
- 财务类编号不要允许重用。审计日志不要提供物理删除。
- 凭证失败不要靠删业务单据来「修」。队列重试或手工补凭证。
- 飞书、查验、扫描、大模型都允许为空。为空时关掉那一块，不要让整个进程起不来，也不要把空目录伪装成「没有文件」。
- `.env`、备份、`data/uploads` 不进 Git。

模块级说明：

- 认证：[server/modules/auth/README.md](server/modules/auth/README.md)
- 账号：[server/modules/identity/README.md](server/modules/identity/README.md)
- 纳税主体：[server/modules/tax/README.md](server/modules/tax/README.md)
- 项目：[server/modules/projects/README.md](server/modules/projects/README.md)
- 财务：[server/modules/finance/README.md](server/modules/finance/README.md)
- 报表与年结：[server/modules/finance-reports/README.md](server/modules/finance-reports/README.md)
- 凭证：[server/modules/voucher/README.md](server/modules/voucher/README.md)
- 资产：[server/modules/asset/README.md](server/modules/asset/README.md)
- 人力：[server/modules/hr/README.md](server/modules/hr/README.md)
- 预算三算：[server/modules/fin-budget/README.md](server/modules/fin-budget/README.md)
- 指标：[server/modules/bi/README.md](server/modules/bi/README.md)
- 字典与参数：[server/modules/system-config/README.md](server/modules/system-config/README.md)
- 运维：[docs/RUNBOOK.md](docs/RUNBOOK.md)
