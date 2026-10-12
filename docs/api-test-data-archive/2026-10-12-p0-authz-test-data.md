# P0 鉴权收紧自测数据留档（2026-10-12）

## hr_recruit_req

- id: ba0365be-cb6a-4777-8ce6-7d617036cd5d
- code: REC2026100001
- title: [API_TEST] 鉴权收紧回归测试
- 用途：验证 POST /api/hr/recruit-reqs 加 @CanRole(['admin']) 后 auth 链路仍 201
- 状态：已删除

## md_supplier

- id: 01d1e8bc-18e8-46c3-b653-c4307ca23cf6
- code: SUP2026100001
- name: [API_TEST] 外协结算验证供应商
- 用途：验证 GET /api/finance/vendor-settlement/preview（N+1 修复后）200
- 状态：已删除
