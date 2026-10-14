/**
 * C-12 路由元数据登记表（OpenAPI 契约的唯一来源）。
 *
 * 只登记**本次批次二新增**的接口（银行账户/流水/对账、异步导出、待办中心、OpenAPI 自身）。
 * 未登记的既有 318 条路由不在本次范围内（属需求书 B-23 的 DTO 改造范畴）。
 *
 * 约束：本文件是纯数据（schema 为 OpenAPI/JSON Schema 子集），
 * 不 import 任何 NestJS / Drizzle / DTO 类，因此：
 *  - `node scripts/gen-openapi.mjs` 无需数据库与编译产物即可执行；
 *  - 运行时可把它挂到 /api/openapi.json 提供在线契约。
 * 与 DTO 的一致性由 tasks.openapi.spec.ts 反向校验。
 */

import type { OpenApiSchema, RoutesCatalog } from './openapi.builder';

const UUID: OpenApiSchema = { type: 'string', format: 'uuid' };
const PERIOD: OpenApiSchema = {
  type: 'string',
  pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
  description: '业务期间，格式 YYYY-MM',
};
const PAGE: OpenApiSchema = { type: 'integer', minimum: 1, default: 1 };
const PAGE_SIZE: OpenApiSchema = { type: 'integer', minimum: 1, maximum: 200, default: 20 };
const MONEY_2: OpenApiSchema = { type: 'number', multipleOf: 0.01, description: '金额（元，最多 2 位小数）' };

const BANK_STATEMENT_MAPPING: OpenApiSchema = {
  type: 'object',
  required: ['transactionDate', 'amount'],
  description: '导入字段映射：键为标准列名，值为文件中的列名',
  properties: {
    transactionDate: { type: 'string', description: '交易日期列名（必填）' },
    direction: { type: 'string', description: '借贷方向列名（可选）' },
    creditKeywords: { type: 'string', description: '收入关键词，逗号分隔（可选）' },
    debitKeywords: { type: 'string', description: '支出关键词，逗号分隔（可选）' },
    amount: { type: 'string', description: '金额列名（必填）' },
    balance: { type: 'string', description: '余额列名（可选）' },
    counterpartyName: { type: 'string', description: '对方户名列名（可选）' },
    counterpartyAccount: { type: 'string', description: '对方账号列名（可选）' },
    summary: { type: 'string', description: '摘要列名（可选）' },
    transactionNo: { type: 'string', description: '交易流水号列名（可选，用于去重）' },
    hasHeader: { type: 'boolean', description: '是否含表头行，默认 true' },
    sheetName: { type: 'string', description: 'xlsx 工作表名（可选）' },
  },
  additionalProperties: false,
};

const FILTER_PARAMS: OpenApiSchema = {
  type: 'object',
  description: '导出筛选参数（键需在该资源的 filters 中登记，非法键会被忽略）',
  additionalProperties: true,
};

const schemas: Record<string, OpenApiSchema> = {
  BankAccountItem: {
    type: 'object',
    required: ['id', 'code', 'name', 'accountNo', 'bankName', 'currency'],
    properties: {
      id: UUID,
      code: { type: 'string', description: '账户编码 BNK+YYYYMM+4 位流水' },
      name: { type: 'string', description: '账户名' },
      accountNo: { type: 'string', description: '银行账号（账号 + 币种唯一）' },
      bankName: { type: 'string', description: '开户行' },
      branchName: { type: 'string', nullable: true, description: '开户支行' },
      currency: { type: 'string', description: '币种（3 位大写字母）' },
      accountCode: { type: 'string', nullable: true, description: '关联会计科目编码' },
      accountName: { type: 'string', nullable: true, description: '科目名称' },
      openingBalance: MONEY_2,
      isDefault: { type: 'boolean' },
      status: { type: 'string', enum: ['active', 'disabled'] },
      contactPerson: { type: 'string', nullable: true },
      contactPhone: { type: 'string', nullable: true },
      remark: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateBankAccountDto: {
    type: 'object',
    required: ['name', 'accountNo', 'bankName'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      accountNo: { type: 'string', minLength: 1, maxLength: 64 },
      bankName: { type: 'string', minLength: 1, maxLength: 200 },
      branchName: { type: 'string', maxLength: 200 },
      currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
      accountCode: { type: 'string', maxLength: 20 },
      openingBalance: MONEY_2,
      isDefault: { type: 'boolean' },
      status: { type: 'string', enum: ['active', 'disabled'] },
      contactPerson: { type: 'string', maxLength: 50 },
      contactPhone: { type: 'string', maxLength: 30 },
      remark: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
  UpdateBankAccountDto: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      accountNo: { type: 'string', minLength: 1, maxLength: 64 },
      bankName: { type: 'string', minLength: 1, maxLength: 200 },
      branchName: { type: 'string', maxLength: 200 },
      currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
      accountCode: { type: 'string', maxLength: 20 },
      openingBalance: MONEY_2,
      isDefault: { type: 'boolean' },
      status: { type: 'string', enum: ['active', 'disabled'] },
      contactPerson: { type: 'string', maxLength: 50 },
      contactPhone: { type: 'string', maxLength: 30 },
      remark: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
  BankImportMappingItem: {
    type: 'object',
    required: ['id', 'name', 'mapping'],
    properties: {
      id: UUID,
      name: { type: 'string' },
      bankName: { type: 'string', nullable: true },
      mapping: BANK_STATEMENT_MAPPING,
      remark: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  SaveBankImportMappingDto: {
    type: 'object',
    required: ['name', 'mapping'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      bankName: { type: 'string', maxLength: 200 },
      mapping: BANK_STATEMENT_MAPPING,
      remark: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
  BankStatementItem: {
    type: 'object',
    required: ['id', 'bankAccountId', 'transactionDate', 'direction', 'amount'],
    properties: {
      id: UUID,
      bankAccountId: UUID,
      bankAccountName: { type: 'string', nullable: true },
      transactionDate: { type: 'string', format: 'date' },
      direction: { type: 'string', enum: ['income', 'expense'] },
      amount: MONEY_2,
      balance: { ...MONEY_2, nullable: true },
      counterpartyName: { type: 'string', nullable: true },
      counterpartyAccount: { type: 'string', nullable: true },
      summary: { type: 'string', nullable: true },
      transactionNo: { type: 'string', nullable: true, description: '银行交易流水号' },
      dedupeKey: { type: 'string', description: '去重键（流水号或业务指纹）' },
      matchStatus: { type: 'string', enum: ['unmatched', 'matched', 'manual', 'ignored'] },
      bizType: { type: 'string', nullable: true, enum: ['receipt', 'payment', 'voucher'] },
      bizId: { ...UUID, nullable: true },
      bizCode: { type: 'string', nullable: true },
      matchScore: { type: 'number', nullable: true, description: '自动匹配得分 0~100' },
      remark: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  BankStatementImportResult: {
    type: 'object',
    required: ['bankAccountId', 'totalRows', 'imported', 'duplicated', 'invalid'],
    properties: {
      bankAccountId: UUID,
      totalRows: { type: 'integer', description: '文件中的数据行数' },
      imported: { type: 'integer', description: '实际入库条数' },
      duplicated: { type: 'integer', description: '按交易流水号/业务指纹去重跳过的条数' },
      invalid: { type: 'integer', description: '字段非法跳过的条数' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['row', 'reason'],
          properties: {
            row: { type: 'integer', description: '数据行号，0 表示整体提示' },
            reason: { type: 'string', description: '跳过原因（中文）' },
          },
        },
      },
      match: {
        type: 'object',
        description: '导入后匹配率统计',
        properties: {
          total: { type: 'integer' },
          matched: { type: 'integer' },
          unmatched: { type: 'integer' },
          ignored: { type: 'integer' },
          matchRate: { type: 'number', description: '匹配率 = matched / (total − ignored)' },
        },
      },
    },
  },
  BankStatementMatchStat: {
    type: 'object',
    required: ['total', 'matched', 'unmatched', 'ignored', 'matchRate'],
    properties: {
      bankAccountId: { ...UUID, nullable: true },
      period: { type: 'string', nullable: true },
      total: { type: 'integer' },
      matched: { type: 'integer' },
      unmatched: { type: 'integer' },
      ignored: { type: 'integer' },
      matchRate: { type: 'number' },
    },
  },
  AutoMatchResult: {
    type: 'object',
    required: ['scanned', 'matched'],
    properties: {
      scanned: { type: 'integer' },
      matched: { type: 'integer' },
      details: {
        type: 'array',
        items: {
          type: 'object',
          required: ['statementId', 'bizType', 'bizId', 'score'],
          properties: {
            statementId: UUID,
            bizType: { type: 'string', enum: ['receipt', 'payment', 'voucher'] },
            bizId: UUID,
            bizCode: { type: 'string' },
            score: { type: 'number', description: '匹配得分（≥60 才自动匹配）' },
          },
        },
      },
    },
  },
  ManualMatchBankStatementDto: {
    type: 'object',
    required: ['bizType', 'bizId'],
    properties: {
      bizType: { type: 'string', enum: ['receipt', 'payment', 'voucher'] },
      bizId: UUID,
      remark: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
  ImportBankStatementDto: {
    type: 'object',
    required: ['bankAccountId', 'mapping'],
    description: 'multipart/form-data：file 为机器可读的 .xlsx/.csv，其余字段为表单文本域',
    properties: {
      bankAccountId: UUID,
      mapping: {
        type: 'string',
        minLength: 2,
        description: 'JSON 字符串形式的字段映射（见 BankStatementMapping）',
      },
      remark: { type: 'string', maxLength: 500 },
      autoMatch: {
        type: 'string',
        enum: ['true', 'false'],
        description: '导入后是否自动匹配，默认 true',
      },
    },
    additionalProperties: false,
  },
  AutoMatchBankStatementDto: {
    type: 'object',
    properties: {
      bankAccountId: UUID,
      period: PERIOD,
      limit: { type: 'integer', minimum: 1, description: '单次扫描上限，默认 1000' },
    },
    additionalProperties: false,
  },
  UnmatchBankStatementDto: {
    type: 'object',
    properties: { remark: { type: 'string', maxLength: 500 } },
    additionalProperties: false,
  },
  BankReconciliationReport: {
    type: 'object',
    required: [
      'bankAccountId',
      'period',
      'bankStatementBalance',
      'adjustedBankBalance',
      'bookBalance',
      'adjustedBookBalance',
      'checks',
      'balanced',
    ],
    properties: {
      bankAccountId: UUID,
      bankAccountName: { type: 'string' },
      bankAccountNo: { type: 'string' },
      accountCode: { type: 'string', description: '企业账面余额取数科目' },
      period: PERIOD,
      currency: { type: 'string' },
      bankStatementBalance: MONEY_2,
      bankStatementBalanceSource: { type: 'string', enum: ['statement', 'manual', 'none'] },
      enterpriseReceivedBankNotReceived: { ...MONEY_2, description: '企业已收银行未收（加项）' },
      enterprisePaidBankNotPaid: { ...MONEY_2, description: '企业已付银行未付（减项）' },
      bankReceivedEnterpriseNotReceived: { ...MONEY_2, description: '银行已收企业未收（加项）' },
      bankPaidEnterpriseNotPaid: { ...MONEY_2, description: '银行已付企业未付（减项）' },
      adjustedBankBalance: { ...MONEY_2, description: '调节后银行对账单余额' },
      bookBalance: { ...MONEY_2, description: '企业账面余额（1002 及末级科目期末余额）' },
      adjustedBookBalance: { ...MONEY_2, description: '调节后企业账面余额' },
      outstandingItems: {
        type: 'array',
        description: '未达账项明细（可追溯到具体流水或凭证）',
        items: {
          type: 'object',
          required: ['side', 'direction', 'source', 'sourceId', 'amount'],
          properties: {
            side: { type: 'string', enum: ['bank_only', 'book_only'] },
            direction: { type: 'string', enum: ['income', 'expense'] },
            source: { type: 'string', enum: ['bank_statement', 'voucher'] },
            sourceId: UUID,
            sourceCode: { type: 'string', nullable: true },
            tradeDate: { type: 'string', format: 'date' },
            amount: MONEY_2,
            description: { type: 'string' },
          },
        },
      },
      checks: {
        type: 'array',
        description: '恒等式断言（含 passed 与 difference）',
        items: {
          type: 'object',
          required: ['key', 'label', 'left', 'right', 'difference', 'passed'],
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            left: { type: 'number' },
            right: { type: 'number' },
            difference: { type: 'number' },
            passed: { type: 'boolean' },
          },
        },
      },
      balanced: { type: 'boolean', description: '所有断言是否全部通过' },
      outstandingCount: { type: 'integer' },
      generatedAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateExportTaskDto: {
    type: 'object',
    required: ['resourceType'],
    properties: {
      resourceType: {
        type: 'string',
        enum: [
          'bank_statement',
          'bank_statement_unmatched',
          'bank_reconciliation',
          'bank_account',
        ],
      },
      format: { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' },
      filterParams: FILTER_PARAMS,
    },
    additionalProperties: false,
  },
  ExportTaskItem: {
    type: 'object',
    required: ['id', 'code', 'resourceType', 'format', 'status'],
    properties: {
      id: UUID,
      code: { type: 'string', description: '任务编号 EXP+YYYYMM+4 位流水' },
      resourceType: { type: 'string' },
      resourceLabel: { type: 'string', description: '资源中文名' },
      format: { type: 'string', enum: ['xlsx', 'csv'] },
      filterParams: FILTER_PARAMS,
      filterSummary: { type: 'string', description: '筛选条件说明（写入文件首行，审计留痕）' },
      status: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed'] },
      fileName: { type: 'string', nullable: true },
      fileSize: { type: 'integer', nullable: true },
      rowCount: { type: 'integer', nullable: true },
      errorMessage: { type: 'string', nullable: true },
      requestedBy: { type: 'string', nullable: true },
      requestedByName: { type: 'string', nullable: true, description: '导出人（审计）' },
      startedAt: { type: 'string', format: 'date-time', nullable: true },
      finishedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      downloadUrl: { type: 'string', nullable: true },
    },
  },
  TaskItem: {
    type: 'object',
    required: ['bizType', 'bizId', 'title', 'urgency', 'url'],
    properties: {
      bizType: { type: 'string', description: '统一待办业务类型' },
      bizId: UUID,
      bizCode: { type: 'string', nullable: true },
      title: { type: 'string' },
      urgency: { type: 'string', enum: ['overdue', 'urgent', 'normal'] },
      dueAt: { type: 'string', format: 'date', nullable: true },
      url: { type: 'string', description: '前端跳转地址（点击直达详情）' },
      moduleLabel: { type: 'string' },
      detail: { type: 'string', nullable: true },
    },
  },
  TaskSummary: {
    type: 'object',
    required: ['total', 'overdue', 'urgent', 'normal', 'byType'],
    properties: {
      total: { type: 'integer', description: '角标总数' },
      overdue: { type: 'integer' },
      urgent: { type: 'integer' },
      normal: { type: 'integer' },
      byType: {
        type: 'array',
        items: {
          type: 'object',
          required: ['bizType', 'label', 'count'],
          properties: {
            bizType: { type: 'string' },
            label: { type: 'string' },
            count: { type: 'integer' },
          },
        },
      },
    },
  },
};

/** 分页/数组包装 schema：避免 $ref 悬空（响应说明里引用） */
const PAGED_ENVELOPE: OpenApiSchema = {
  type: 'object',
  required: ['items', 'total', 'page', 'pageSize'],
  description: '统一分页结构（items 的元素类型见各接口响应说明）',
  properties: {
    items: { type: 'array', items: {} },
    total: { type: 'integer' },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
  },
};

const ARRAY_ENVELOPE: OpenApiSchema = {
  type: 'array',
  description: '数组结构（元素类型见各接口响应说明）',
  items: {},
};

export const ROUTES_CATALOG: RoutesCatalog = {
  title: '晟笙数据服务 ERP 开放接口',
  version: '2.5.0-batch2',
  description:
    '批次二新增接口的 OpenAPI 3.0 契约（银行账户/流水/银企对账、异步导出、待办中心）。' +
    '鉴权：全部接口需登录（会话 Cookie）；标注 x-auth 的能力码与 shared/rbac.ts 矩阵一致。' +
    '错误结构：{ error: { code, message, details?, timestamp } }。',
  schemas: {
    ...schemas,
    PagedEnvelope: PAGED_ENVELOPE,
    ArrayEnvelope: ARRAY_ENVELOPE,
  },
  routes: [
    /* ==================== C-02 银行账户 ==================== */
    {
      method: 'get',
      path: '/api/finance/bank-accounts',
      operationId: 'listBankAccounts',
      summary: '银行账户列表',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [
        { name: 'page', in: 'query', required: false, schema: PAGE },
        { name: 'pageSize', in: 'query', required: false, schema: PAGE_SIZE },
        { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['active', 'disabled'] } },
        { name: 'keyword', in: 'query', required: false, schema: { type: 'string', description: '账户名/账号/开户行模糊搜索' } },
      ],
      responses: [{ status: '200', description: '账户分页列表', schemaName: 'BankAccountItem', arrayOf: 'PagedEnvelope' }],
    },
    {
      method: 'get',
      path: '/api/finance/bank-accounts/{id}',
      operationId: 'getBankAccount',
      summary: '银行账户详情',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      responses: [{ status: '200', description: '账户详情', schemaName: 'BankAccountItem' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-accounts',
      operationId: 'createBankAccount',
      summary: '新建银行账户',
      description: '账号 + 币种唯一，重复创建返回 409；每币种最多一个默认账户。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      requestBody: { schemaName: 'CreateBankAccountDto', required: true, contentType: 'application/json' },
      responses: [{ status: '200', description: '创建成功', schemaName: 'BankAccountItem' }],
    },
    {
      method: 'patch',
      path: '/api/finance/bank-accounts/{id}',
      operationId: 'updateBankAccount',
      summary: '更新银行账户',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      requestBody: { schemaName: 'UpdateBankAccountDto', required: true, contentType: 'application/json' },
      responses: [{ status: '200', description: '更新成功', schemaName: 'BankAccountItem' }],
    },

    /* ==================== C-02 导入映射模板 ==================== */
    {
      method: 'get',
      path: '/api/finance/bank-import-mappings',
      operationId: 'listBankImportMappings',
      summary: '导入字段映射模板列表',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      responses: [{ status: '200', description: '映射模板列表', schemaName: 'BankImportMappingItem', arrayOf: 'ArrayEnvelope' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-import-mappings',
      operationId: 'saveBankImportMapping',
      summary: '保存导入字段映射模板',
      description: '同名模板重复保存返回 409（唯一键 name）。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      requestBody: { schemaName: 'SaveBankImportMappingDto', required: true, contentType: 'application/json' },
      responses: [{ status: '200', description: '保存成功', schemaName: 'BankImportMappingItem' }],
    },

    /* ==================== C-02 银行流水 ==================== */
    {
      method: 'get',
      path: '/api/finance/bank-statements',
      operationId: 'listBankStatements',
      summary: '银行流水列表',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [
        { name: 'bankAccountId', in: 'query', required: false, schema: UUID },
        { name: 'period', in: 'query', required: false, schema: PERIOD },
        {
          name: 'matchStatus',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['unmatched', 'matched', 'manual', 'ignored'] },
        },
        { name: 'page', in: 'query', required: false, schema: PAGE },
        { name: 'pageSize', in: 'query', required: false, schema: PAGE_SIZE },
      ],
      responses: [{ status: '200', description: '流水分页列表', schemaName: 'BankStatementItem', arrayOf: 'PagedEnvelope' }],
    },
    {
      method: 'get',
      path: '/api/finance/bank-statements/unmatched',
      operationId: 'listUnmatchedBankStatements',
      summary: '未匹配银行流水清单',
      description: '人工核对入口：只返回 matchStatus=unmatched 的流水。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [
        { name: 'bankAccountId', in: 'query', required: false, schema: UUID },
        { name: 'period', in: 'query', required: false, schema: PERIOD },
        { name: 'page', in: 'query', required: false, schema: PAGE },
        { name: 'pageSize', in: 'query', required: false, schema: PAGE_SIZE },
      ],
      responses: [{ status: '200', description: '未匹配流水分页列表', schemaName: 'BankStatementItem', arrayOf: 'PagedEnvelope' }],
    },
    {
      method: 'get',
      path: '/api/finance/bank-statements/match-stat',
      operationId: 'bankStatementMatchStatistics',
      summary: '流水匹配率统计',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [
        { name: 'bankAccountId', in: 'query', required: false, schema: UUID },
        { name: 'period', in: 'query', required: false, schema: PERIOD },
      ],
      responses: [{ status: '200', description: '匹配率统计', schemaName: 'BankStatementMatchStat' }],
    },
    {
      method: 'get',
      path: '/api/finance/bank-statements/{id}',
      operationId: 'getBankStatement',
      summary: '银行流水详情',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      responses: [{ status: '200', description: '流水详情', schemaName: 'BankStatementItem' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-statements/import',
      operationId: 'importBankStatements',
      summary: '导入银行流水（Excel/CSV）',
      description:
        'multipart/form-data：file 为 .xlsx/.csv，mapping 为 JSON 字符串（字段映射）。' +
        '按交易流水号去重（缺失时用业务指纹），重复行跳过并在 errors 中提示；导入后自动匹配。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      requestBody: { schemaName: 'ImportBankStatementDto', required: true, contentType: 'multipart/form-data' },
      responses: [{ status: '201', description: '导入结果与匹配率', schemaName: 'BankStatementImportResult' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-statements/auto-match',
      operationId: 'autoMatchBankStatements',
      summary: '执行自动匹配',
      description: '规则：金额相同 + 日期 ±3 天为硬条件，摘要命中对方名称/单号加分，得分 ≥60 自动匹配。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      requestBody: { schemaName: 'AutoMatchBankStatementDto', required: true, contentType: 'application/json' },
      responses: [{ status: '201', description: '匹配结果', schemaName: 'AutoMatchResult' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-statements/{id}/match',
      operationId: 'manualMatchBankStatement',
      summary: '人工关联流水与单据',
      description: '同一流水重复关联同一单据返回 409；改绑其他单据为幂等更新。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      requestBody: { schemaName: 'ManualMatchBankStatementDto', required: true, contentType: 'application/json' },
      responses: [{ status: '201', description: '关联后的流水', schemaName: 'BankStatementItem' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-statements/{id}/unmatch',
      operationId: 'unmatchBankStatement',
      summary: '取消流水关联',
      description: '幂等：本无匹配时也返回当前流水。',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      requestBody: { schemaName: 'UnmatchBankStatementDto', required: true, contentType: 'application/json' },
      responses: [{ status: '201', description: '取消后的流水', schemaName: 'BankStatementItem' }],
    },
    {
      method: 'post',
      path: '/api/finance/bank-statements/{id}/ignore',
      operationId: 'ignoreBankStatement',
      summary: '标记流水忽略（无需匹配）',
      tags: ['银行账户与流水'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      requestBody: { schemaName: 'UnmatchBankStatementDto', required: true, contentType: 'application/json' },
      responses: [{ status: '201', description: '标记后的流水', schemaName: 'BankStatementItem' }],
    },

    /* ==================== C-03 银企对账 ==================== */
    {
      method: 'get',
      path: '/api/finance/bank-reconciliation',
      operationId: 'getBankReconciliation',
      summary: '银行存款余额调节表',
      description:
        '银行对账单余额 + 企业已收银行未收 − 企业已付银行未付 = 企业账面余额 + 银行已收企业未收 − 银行已付企业未付。' +
        'checks 内含恒等式断言（passed / difference）；未达账项可追溯到具体流水或凭证。',
      tags: ['银企对账'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [
        { name: 'bankAccountId', in: 'query', required: false, schema: UUID, description: '缺省取默认账户' },
        { name: 'period', in: 'query', required: true, schema: PERIOD },
        { name: 'bankBalance', in: 'query', required: false, schema: MONEY_2, description: '手工指定的银行对账单期末余额（覆盖自动取数）' },
      ],
      responses: [{ status: '200', description: '调节表与断言结果', schemaName: 'BankReconciliationReport' }],
    },

    /* ==================== C-07 异步导出 ==================== */
    {
      method: 'post',
      path: '/api/exports',
      operationId: 'createExportTask',
      summary: '创建异步导出任务',
      description:
        '返回 202 与任务对象（status=pending），后台生成文件；' +
        '同一用户 + 同资源 + 同筛选 + 同格式 60 秒内重复提交返回已有任务（幂等）。',
      tags: ['异步导出'],
      auth: '@NeedLogin + @CanCapability(finance_write)',
      requestBody: { schemaName: 'CreateExportTaskDto', required: true, contentType: 'application/json' },
      responses: [{ status: '202', description: '任务已创建', schemaName: 'ExportTaskItem' }],
    },
    {
      method: 'get',
      path: '/api/exports',
      operationId: 'listExportTasks',
      summary: '我的导出列表',
      description: '非 admin 仅返回本人发起的任务；admin 可见全部。',
      tags: ['异步导出'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [
        { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed'] } },
        {
          name: 'resourceType',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['bank_statement', 'bank_statement_unmatched', 'bank_reconciliation', 'bank_account'],
          },
        },
        { name: 'page', in: 'query', required: false, schema: PAGE },
        { name: 'pageSize', in: 'query', required: false, schema: PAGE_SIZE },
      ],
      responses: [{ status: '200', description: '导出任务分页列表', schemaName: 'ExportTaskItem', arrayOf: 'PagedEnvelope' }],
    },
    {
      method: 'get',
      path: '/api/exports/{id}',
      operationId: 'getExportTask',
      summary: '导出任务状态与下载链接',
      tags: ['异步导出'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      responses: [{ status: '200', description: '任务详情（含 downloadUrl）', schemaName: 'ExportTaskItem' }],
    },
    {
      method: 'get',
      path: '/api/exports/{id}/download',
      operationId: 'downloadExportFile',
      summary: '下载导出文件',
      description: '仅任务发起人或 admin 可下载；未完成返回 400，越权返回 403。',
      tags: ['异步导出'],
      auth: '@NeedLogin + @CanCapability(finance)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: UUID }],
      responses: [
        { status: '200', description: '文件流（Content-Disposition: attachment）' },
      ],
    },

    /* ==================== C-08 待办中心 ==================== */
    {
      method: 'get',
      path: '/api/tasks/my',
      operationId: 'listMyTasks',
      summary: '我的待办（聚合）',
      description:
        '并行聚合各模块"待我处理"条目：待审批（报价/合同/付款/报销/请假/补卡/采购/资产变更/交付物验收）、' +
        '待处理预警（应收逾期/交付逾期/预算超支/合同到期/租约到期）、待确认（对账差异）。' +
        '统一模型 { bizType, bizId, bizCode, title, urgency, dueAt, url }，点击直达由前端按 url 跳转。',
      tags: ['待办中心'],
      auth: '@NeedLogin + @CanCapability(dashboard)',
      parameters: [
        { name: 'bizType', in: 'query', required: false, schema: { type: 'string', description: '按业务类型过滤' } },
        { name: 'urgency', in: 'query', required: false, schema: { type: 'string', enum: ['overdue', 'urgent', 'normal'] } },
        { name: 'sortBy', in: 'query', required: false, schema: { type: 'string', enum: ['urgency', 'dueAt', 'bizType'], default: 'urgency' } },
        { name: 'page', in: 'query', required: false, schema: PAGE },
        { name: 'pageSize', in: 'query', required: false, schema: PAGE_SIZE },
      ],
      responses: [{ status: '200', description: '待办分页列表', schemaName: 'TaskItem', arrayOf: 'PagedEnvelope' }],
    },
    {
      method: 'get',
      path: '/api/tasks/summary',
      operationId: 'getMyTaskSummary',
      summary: '我的待办角标数量',
      description: 'total 与 /api/tasks/my 的 total 完全一致（同一取数实现）。',
      tags: ['待办中心'],
      auth: '@NeedLogin + @CanCapability(dashboard)',
      responses: [{ status: '200', description: '角标汇总', schemaName: 'TaskSummary' }],
    },

    /* ==================== C-12 在线契约 ==================== */
    {
      method: 'get',
      path: '/api/openapi/json',
      operationId: 'getOpenApiDocument',
      summary: '获取本批次接口的 OpenAPI 3.0 文档',
      description:
        '与 `npm run gen:openapi` 产出的 docs/openapi.json 使用同一实现，键已递归排序。' +
        'Swagger UI 仅在 SWAGGER_ENABLED=true 时挂载于 /api-docs（Basic 认证保护）。',
      tags: ['开放接口'],
      auth: '@NeedLogin + @CanCapability(audit)',
      responses: [{ status: '200', description: 'OpenAPI 3.0 文档对象' }],
    },
  ],
};
