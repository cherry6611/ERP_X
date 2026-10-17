/**
 * 数据资产脱敏面板的文案表（§5.9 / F8 拆分）。
 *
 * 两张表原先都定义在 `DataMaskPanel.tsx` 顶部，随「登记脱敏字段」弹窗一起搬出：
 *
 * | 表 | 消费点 |
 * |---|---|
 * | `FIELD_KIND_LABELS` | 面板「脱敏字段登记」表的「字段语义」列（`field.fieldKind` → 中文）与「登记脱敏字段」弹窗的下拉选项 |
 * | `REVOKE_REASON_LABELS` | 「回收授权」弹窗的下拉选项与回收成功 toast 里的原因 |
 *
 * `FIELD_KIND_LABELS` 有**两个**消费点（父组件的表格 + 子弹窗），因此提成独立模块，
 * 而不是留在任一组件里 —— 否则另一处只能留副本，下次新增字段语义必然只改一处。
 * 本域已有"各组件自带副本"的形态（`DataAssetBadge.tsx` 的两张状态表），此处不再重复。
 *
 * 为什么不必再配 spec：两张表的类型是 `Record<联合类型, string>`，
 * **键缺一个或多一个都会编译失败** —— 这正是"漏键 → 界面显示英文码"那个缺陷的
 * 拦截点，比运行期断言更强。文案本身的正确性无法靠单测证明。
 *
 * ⚠️ 内容为**逐字搬运**：键、键序与文案都与拆分前完全一致。
 * 键序就是界面顺序（两个下拉都用 `Object.keys(...)` 渲染选项），不要按字母重排。
 */
import type {
  GrantRevokeReason,
  SensitiveFieldKind,
} from '@shared/api.interface';

export const FIELD_KIND_LABELS: Record<SensitiveFieldKind, string> = {
  name: '姓名',
  phone: '手机号',
  email: '邮箱',
  id_card: '身份证号',
  bank_account: '银行账号',
  address: '地址',
  amount: '金额',
  location: '定位',
  other: '其它',
};

export const REVOKE_REASON_LABELS: Record<GrantRevokeReason, string> = {
  expired: '到期自动回收',
  manual: '人工主动回收',
  contract_terminated: '合同终止',
  violation: '违规使用',
  project_closed: '项目结项',
};
