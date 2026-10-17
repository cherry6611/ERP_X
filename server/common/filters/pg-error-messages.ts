/**
 * PostgreSQL `23505`（唯一约束冲突）→ **可执行的中文文案**。
 *
 * ## 为什么需要这个模块
 *
 * `exception.filter.ts` 原来把**所有**唯一约束冲突都映射成同一句：
 *
 * > 记录已存在，请勿重复提交
 *
 * 但这句话只在"同一张单被提交了两次"时才对。实测
 * （`pg_indexes` 普查，非 pkey、非纯 code 的唯一索引共 **40 个**）里绝大多数
 * 是**业务规则**，不是重复提交：
 *
 * | 约束 | 真实含义 |
 * |---|---|
 * | `uq_erp_project_one_contract` | **一个合同只能立一个项目** |
 * | `uq_crm_opp_contract` | **一个合同只能由一个商机转化** |
 * | `uq_erp_project_revenue_project_period` | **同项目同期间只能确认一次收入** |
 * | `uq_erp_timesheet_employee_project_date` | **同人同项目同天只能报一次工时** |
 * | `uq_fin_year_end_close_year` | **该年度该主体已年结** |
 *
 * 本仓在 `costs.service.ts:530` 已经吃过这个亏并留了注释：
 * *"『记录已存在，请勿重复提交』，使用者不知道该怎么办"* ——
 * 但那只在成本模块**单独**兜住了一处，其余 39 个索引仍走通用文案。
 *
 * ## 为什么放在过滤器里统一做，而不是各 service 各自预检
 *
 * ① 预检（先 SELECT 再 INSERT）在并发下有 TOCTOU 窗口，**约束才是真正的守门人**；
 * ② 40 个索引逐个写预检是 40 份重复代码，且新增索引时必然漏；
 * ③ 这里只是把**已经发生的**冲突翻译成人话，零额外查询、无竞态。
 *
 * ## 判据
 *
 * `conflictMessage(constraintName)`：
 * - 命中映射表 → 该业务规则的具体说明（**并告诉使用者下一步做什么**）
 * - 未命中 / 拿不到约束名 → `null`，调用方回落通用文案
 *
 * ⚠️ 新增唯一索引时**建议**在这里补一条 —— 但漏了也不会出错，
 * 只是回落成通用文案。宁可回落，不要在这里猜。
 */

/** 约束名 → 可执行文案（写法遵循 `audit-error-messages.mjs` 的中文要求） */
export const UNIQUE_CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  /* ── 项目 / 合同 / 商机：一对一关系 ── */
  uq_erp_project_one_contract:
    '该合同已关联项目，一个合同只能立一个项目；请到已有项目下继续操作，或先解除原项目的关联',
  uq_crm_opp_contract:
    '该合同已由其它商机转化而来，一个合同只能由一个商机转化；请勿重复转化',

  /* ── 收入确认：同期一次 ── */
  uq_erp_project_revenue_project_period:
    '该项目在此期间已确认过收入，同一项目同一期间只能确认一次；如需更正请先冲销原确认记录',

  /* ── 工时：同人同项目同天一次 ── */
  uq_erp_timesheet_employee_project_date:
    '该员工当日在项目上已有工时记录，同一天同一项目只能填报一次；请修改原记录而不是新增',

  /* ── 固定资产 ── */
  uq_ast_asset_purchase_order:
    '该采购订单已生成固定资产卡片，一张采购订单只能生成一张卡片',
  uq_ast_depreciation_asset_period:
    '该资产在此期间已计提折旧，同一资产同一期间只能计提一次',
  uq_ast_disposal_active:
    '该资产已有未完成的处置单，请先完成或撤销原处置单',
  uq_ast_disposal_voucher_ref:
    '该凭证已用于资产处置，同一凭证不能重复处置',

  /* ── 财务期间 / 申报 ── */
  uq_fin_year_end_close_year:
    '该会计年度该纳税主体已完成年结，不能重复年结；如需调整请先反年结',
  uq_fin_vat_declaration_period_entity:
    '该期间该纳税主体的增值税申报底稿已存在，不能重复生成',
  uq_fin_account_balance_snapshot:
    '该期间该科目该主体的余额快照已存在，不能重复生成',
  uq_fin_report_template_row:
    '该报表该行次已存在，同一报表内行次不能重复',
  uq_fin_voucher_source:
    '该业务单据已生成凭证，请勿重复生成；如需更正请先作废原凭证',

  /* ── 应收 / 应付 / 发票 / 票据 ── */
  uq_erp_ar_source_ref:
    '该来源已登记过应收单，请勿重复登记',
  uq_erp_ap_bill_source_ref:
    '该来源已登记过应付单，请勿重复登记',
  uq_erp_ar_writeoff_reversal:
    '该核销记录已冲销过，不能重复冲销',
  uq_erp_ap_writeoff_reversal:
    '该核销记录已冲销过，不能重复冲销',
  uq_erp_invoice_red_letter_source:
    '该来源已开具过红字发票，不能重复开具',
  uq_erp_invoice_no_date_issued:
    '该发票号码在同一天已开具过，请核对发票号码与开票日期',
  uq_erp_note_no: '该票据号码已存在，请核对票据号码',
  uq_erp_note_log_action:
    '该票据已执行过此操作，不能重复执行',

  /* ── 成本 ── */
  uq_erp_project_cost_source_ref_non_red:
    '该来源已归集过成本，请勿重复归集',
  uq_erp_project_cost_redflush_source_ref:
    '该成本单已红冲过，不能重复红冲',

  /* ── 合同明细 ── */
  uq_contract_item_seq:
    '该合同该版本下此序号已存在，请调整序号',

  /* ── 银行 ── */
  uq_erp_bank_statement_dedupe:
    '该银行流水已导入过（按流水号/业务指纹去重），请勿重复导入',
  uq_erp_bank_statement_match_statement:
    '该银行流水已做过匹配，请先取消原匹配',
  uq_erp_bank_import_mapping_name:
    '该导入映射名称已存在，请换一个名称',

  /* ── 数据资产 ── */
  uq_da_dataset_field_column:
    '该数据集下已存在同名字段，同一数据集内字段名不能重复',

  /* ── 附件 / 版本 ── */
  uq_comp_stored_file_version:
    '该附件的此版本号已存在，请勿重复上传',

  /* ── 飞书同步 / 自动化（多为系统内部重试，文案面向排障） ── */
  uq_sync_in_rec: '该飞书记录已同步入库，请勿重复同步',
  uq_sync_out_biz: '该业务单据已同步到飞书，请勿重复同步',
  uq_comp_feishu_bitable_biz:
    '该业务类型已配置多维表格，同一业务类型只能配置一次',
  uq_comp_feishu_drive_config_single:
    '云空间配置只允许一条，已存在配置记录',
  uq_comp_automation_run_task_date:
    '该自动化任务今日已执行过，同一天同一任务只执行一次',
  uq_comp_voucher_job_source:
    '该来源的凭证任务已存在，请勿重复触发',
  uq_project_drive_sync_attachment:
    '该附件已建立过云盘同步记录，请勿重复同步',
  uq_project_drive_sync_archive:
    '该项目已建立过归档同步记录，请勿重复同步',

  /* ── BI 订阅 ── */
  uq_bi_alert_subscription_user_metric:
    '该指标在此渠道已订阅过，请勿重复订阅',
};

/**
 * 从 PG 错误里取约束名。
 *
 * ⚠️ **两个坑，都实测过**：
 *
 * ① 属性名不是 `constraint`，而是 **`constraint_name`** ——
 *    `postgres.js` 把 `PostgresError` 的字段重命名过了。实测
 *    `Object.keys(err)` = `name, severity_local, severity, code, detail,
 *    schema_name, table_name, constraint_name, file, line, routine`，
 *    其中**没有** `constraint`（`err.constraint === undefined`）。
 *    只认 `constraint` 会让整张映射表永远不生效、静默回落成通用文案。
 *    两个都认，兼容 `pg` 驱动的命名习惯。
 *
 * ② 还要沿 `cause` 链找：drizzle 会把原始 PG 错误包进 `DrizzleQueryError.cause`，
 *    顶层只有 `message`（与 `exception.filter.ts#sqlState` 沿 cause 链找
 *    SQLSTATE 的原因完全相同）。
 */
export function constraintNameOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== 'object') break;
    const rec = current as { constraint?: unknown; constraint_name?: unknown };
    for (const candidate of [rec.constraint, rec.constraint_name]) {
      if (typeof candidate === 'string' && candidate) return candidate;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * 返回该唯一约束冲突的可读说明；无法识别时返回 `null`（调用方回落通用文案）。
 *
 * 也兼容**唯一索引**冲突：PG 在报错时 `constraint` 字段放的是索引名，
 * 与本表的键同名，因此同一张表同时覆盖约束与唯一索引。
 */
export function conflictMessage(error: unknown): string | null {
  const name = constraintNameOf(error);
  if (!name) return null;
  return UNIQUE_CONSTRAINT_MESSAGES[name] ?? null;
}
