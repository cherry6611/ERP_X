// ---- plugin:send_erp_approval_notification_1 ----
// ============================================================
// 插件 send_erp_approval_notification_1 (ERP审批通知) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface SendErpApprovalNotificationOneInput {
  /** 接收通知的用户ID数组 */
  receiverIds: string[];
  /** 通知卡片标题 */
  title: string;
  /** 通知卡片正文内容，支持markdown格式 */
  content: string;
}

/**
 * capabilityClient.load('send_erp_approval_notification_1').call<SendErpApprovalNotificationOneOutput>('send_feishu_message', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { success } = result;
 * 返回值形如：
 *   {"success":false}
 */
export interface SendErpApprovalNotificationOneOutput {
  /** [object Object] */
  success: boolean;
}
// ---- end:send_erp_approval_notification_1 ----

// ---- plugin:erp_bitable_two_way_sync_1 ----
// ============================================================
// 插件 erp_bitable_two_way_sync_1 (ERP与多维表格双向同步) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface ErpBitableTwoWaySyncOneInput {
  /** [object Object] */
  records: {
    record: {

    };
  }[];
}

/**
 * capabilityClient.load('erp_bitable_two_way_sync_1').call<ErpBitableTwoWaySyncOneOutput>('batchAddRecords', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { records } = result;
 * 返回值形如：
 *   {"records":[{"id":"示例文本"}]}
 */
export interface ErpBitableTwoWaySyncOneOutput {
  /** [object Object] */
  records: {
    id: string;
  }[];
}
// ---- end:erp_bitable_two_way_sync_1 ----

// ---- plugin:flexible_labor_hours_sync_1 ----
// ============================================================
// 插件 flexible_labor_hours_sync_1 (灵活用工工时入向同步) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface FlexibleLaborHoursSyncOneAggregatequeryInput {
  /** [object Object] */
  pageSize?: number;
  /** [object Object] */
  sort?: {
    desc?: boolean;
    fieldName: string;
  }[];
  /** [object Object] */
  filter?: {
    conjunction?: string;
    conditions?: {
      fieldName: string;
      operator: string;
      value?: string[];
    }[];
  };
  /** [object Object] */
  expandArrayDimension?: boolean;
  /** [object Object] */
  dimensions?: string[];
  /** [object Object] */
  measures?: {
    aggregation: string;
    alias?: string;
    fieldName: string;
  }[];
  /** [object Object] */
  pageToken?: string;
}

/**
 * capabilityClient.load('flexible_labor_hours_sync_1').call<FlexibleLaborHoursSyncOneAggregatequeryOutput>('aggregateQuery', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { pageToken, result, hasMore } = result;
 * 返回值形如：
 *   {"pageToken":"示例文本","result":[{}],"hasMore":false}
 */
export interface FlexibleLaborHoursSyncOneAggregatequeryOutput {
  /** [object Object] */
  pageToken?: string;
  /** [object Object] */
  result: {

  }[];
  /** [object Object] */
  hasMore: boolean;
}

export interface FlexibleLaborHoursSyncOneBatchaddrecordsInput {
  /** [object Object] */
  records: {
    record: {

    };
  }[];
}

/**
 * capabilityClient.load('flexible_labor_hours_sync_1').call<FlexibleLaborHoursSyncOneBatchaddrecordsOutput>('batchAddRecords', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { records } = result;
 * 返回值形如：
 *   {"records":[{"id":"示例文本"}]}
 */
export interface FlexibleLaborHoursSyncOneBatchaddrecordsOutput {
  /** [object Object] */
  records: {
    id: string;
  }[];
}

export interface FlexibleLaborHoursSyncOneBatchupdaterecordsInput {
  /** [object Object] */
  records: {
    id: string;
    record: {

    };
  }[];
}

/**
 * capabilityClient.load('flexible_labor_hours_sync_1').call<FlexibleLaborHoursSyncOneBatchupdaterecordsOutput>('batchUpdateRecords', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { records } = result;
 * 返回值形如：
 *   {"records":[{"id":"示例文本"}]}
 */
export interface FlexibleLaborHoursSyncOneBatchupdaterecordsOutput {
  /** [object Object] */
  records: {
    id: string;
  }[];
}

export interface FlexibleLaborHoursSyncOneDeleterecordsInput {
  /** [object Object] */
  recordIDs: string[];
}

/**
 * capabilityClient.load('flexible_labor_hours_sync_1').call<FlexibleLaborHoursSyncOneDeleterecordsOutput>('deleteRecords', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { success } = result;
 * 返回值形如：
 *   {"success":false}
 */
export interface FlexibleLaborHoursSyncOneDeleterecordsOutput {
  /** [object Object] */
  success: boolean;
}

export interface FlexibleLaborHoursSyncOneGetrecordInput {
  /** [object Object] */
  recordID: string;
}

/**
 * capabilityClient.load('flexible_labor_hours_sync_1').call<FlexibleLaborHoursSyncOneGetrecordOutput>('getRecord', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { id, record } = result;
 * 返回值形如：
 *   {"id":"示例文本","record":{}}
 */
export interface FlexibleLaborHoursSyncOneGetrecordOutput {
  /** [object Object] */
  id: string;
  /** [object Object] */
  record?: {

  };
}

export interface FlexibleLaborHoursSyncOneSearchrecordsInput {
  /** [object Object] */
  pageToken?: string;
  /** [object Object] */
  pageSize?: number;
  /** [object Object] */
  fieldNames?: string[];
  /** [object Object] */
  sort?: {
    fieldName: string;
    desc?: boolean;
  }[];
  /** [object Object] */
  filter?: {
    conjunction?: string;
    conditions?: {
      operator: string;
      value?: string[];
      fieldName: string;
    }[];
  };
}

/**
 * capabilityClient.load('flexible_labor_hours_sync_1').call<FlexibleLaborHoursSyncOneSearchrecordsOutput>('searchRecords', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { records, hasMore, pageToken, ... } = result;
 * 返回值形如：
 *   {"records":[{"id":"示例文本","record":{}}],"hasMore":false,"pageToken":"示例文本","total":0}
 */
export interface FlexibleLaborHoursSyncOneSearchrecordsOutput {
  /** [object Object] */
  records: {
    id: string;
    record: {

    };
  }[];
  /** [object Object] */
  hasMore: boolean;
  /** [object Object] */
  pageToken?: string;
  /** [object Object] */
  total?: number;
}
// ---- end:flexible_labor_hours_sync_1 ----

// ---- plugin:contract_ledger_archiving_1 ----
// ============================================================
// 插件 contract_ledger_archiving_1 (合同台账出向归档) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface ContractLedgerArchivingOneInput {
  /** [object Object] */
  records: {
    record: {

    };
  }[];
}

/**
 * capabilityClient.load('contract_ledger_archiving_1').call<ContractLedgerArchivingOneOutput>('batchAddRecords', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { records } = result;
 * 返回值形如：
 *   {"records":[{"id":"示例文本"}]}
 */
export interface ContractLedgerArchivingOneOutput {
  /** [object Object] */
  records: {
    id: string;
  }[];
}
// ---- end:contract_ledger_archiving_1 ----

// ---- plugin:quotation_text_to_json_parse_1 ----
// ============================================================
// 插件 quotation_text_to_json_parse_1 (飞书文档报价单文本转JSON结构化解析) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface QuotationTextToJsonParseOneInput {
  /** 待解析的报价单纯文本内容 */
  text: string;
}

/**
 * capabilityClient.load('quotation_text_to_json_parse_1').call<QuotationTextToJsonParseOneOutput>('textToJson', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { validUntil, remark, items, ... } = result;
 * 返回值形如：
 *   {"validUntil":"示例文本","remark":"示例文本","items":[],"title":"示例文本","quoteDate":"示例文本"}
 */
export interface QuotationTextToJsonParseOneOutput {
  /** 报价有效期截止日期，格式为YYYY-MM-DD，无则为null */
  validUntil: string;
  /** 报价单整体备注信息，无则为null */
  remark: string;
  /** 报价明细行数组，items schema: {itemName: string(必填，条目/服务名称), unit: string(数量单位，默认"人天"), quantity: number(数量，默认1), unitPrice: number(不含税单价，默认0), discountPct: number(行折扣百分比0-100，默认0), estUnitCost: number(预估单位成本，无则0), remark: string(行备注，无则null)} */
  items: unknown[];
  /** 报价单标题 */
  title: string;
  /** 报价日期，格式为YYYY-MM-DD，无法识别时为null */
  quoteDate: string;
}
// ---- end:quotation_text_to_json_parse_1 ----