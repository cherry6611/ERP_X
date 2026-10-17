/**
 * 纳税主体列表的列定义（§5.9 / F8）。
 *
 * 从 `TaxEntities.tsx` 抽出的 `TableColumnsType<TaxEntity>` 数组（原文件 208-287 行）。
 * 列定义 80 行，且**改错看不出来**：`render` 里取错字段（例如把进项税率渲染成
 * 销项税率）或挂错按钮时，表格照样渲染、按钮照样能点，只是数字/动作不对 ——
 * typecheck、lint 与单测全都看不见，只能靠逐列读。
 *
 * ## 为什么是工厂函数而不是常量数组
 *
 * 「操作」列的 `render` 闭包了父组件的三样东西，它们随父组件每次渲染而变，
 * 常量数组持有不了，故由父组件在渲染时调用本函数注入：
 *   · `openEdit(row)` —— 打开编辑弹窗并**同步**预置表单（重置语义见 `TaxEntities.tsx`）；
 *   · `toggleStatus(row)` —— 停用前要 `confirmDanger` 二次确认，故留在父组件；
 *   · `reload` —— `useAsyncData` 的重取（「设为默认」成功后调用）。
 *
 * ⚠️ 数组字面量**逐字搬运（含缩进与注释）**：只加了外层 `export function` 与
 * `return columns;`，三个入参在解构处**沿用父组件的原名**（`openEdit` /
 * `toggleStatus` / `reload`），因此列头文案、宽度、`dataIndex`、`render`
 * 与原有注释一个字符未动。
 *
 * ⚠️ **没有**给列定义加 `useMemo`：原文件也没有（本数组本来就是每次渲染新建），
 * 加了会改变 antd 表格状态的重置时机 —— 那是行为变更，不在本次拆分范围内。
 *
 * ## 已核对（本轮）
 *
 * 九个 `dataIndex` 全部存在于契约 `TaxEntity`（`shared/api.interface.ts:3284`）：
 * code / name / taxpayerType / defaultOutputRate / defaultInputRate /
 * urbanMaintRate / vatFilingCycle / isDefault / status —— 没有指向不存在字段的
 * 「死 dataIndex」（那会渲染出一个永久的空列，`tsc` 抓不到）。
 *
 * ## 已发现但本轮**未修**的缺陷（仅记录，供下一轮决策）
 *
 * 1. 「设为默认」按钮对**停用**行也会渲染。服务端 `TaxEntityService.setDefault`
 *    在 `locked[0].status !== 'active'` 时直接拒绝
 *    （`server/modules/tax/tax-entity.service.ts:216`），即该按钮在停用行上
 *    **必然失败**（前端只是 toast 出服务端的中文原因）。
 *    未修原因：本轮要求「逐字搬运 + 零行为变更 + 只做一次结构抽取」，
 *    给它加条件渲染属于行为变更，应单独一轮处理。
 *
 * 2. 更危险的一处在父组件的 `save` 里（不在本文件）：城建税率是自由文本输入，
 *    填 `7%` 这类非数字会让 `Number(...)` 得到 NaN，`JSON.stringify` 把 NaN
 *    序列化成 JSON `null`；服务端 DTO 的 `@IsOptional()` 对 `null` 跳过校验、
 *    service 又按「显式清空」写库（`dto.urbanMaintRate === undefined ? … : dto.…`），
 *    于是**静默清空**已配置的城建税率并 toast 成功。详见本轮报告。
 */
import { TableColumnsType } from 'antd';
import { toast } from 'sonner';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { masterDataApi } from '@client/src/api';
import type { TaxEntity } from '@client/src/api/master-data';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { TaxpayerType } from '@shared/tax';

/** 列定义要用到的父组件局部量（见文件头「为什么是工厂函数」） */
interface TaxEntityColumnsArgs {
  /** 打开「编辑纳税主体」弹窗并同步预置表单（重置触发点仍留在父组件的 openEdit 里） */
  openEdit: (row: TaxEntity) => void;
  /** 启用/停用该主体（含停用前的二次确认） */
  toggleStatus: (row: TaxEntity) => Promise<void>;
  /** 写成功后重取列表（useAsyncData 的 reload，「设为默认」用） */
  reload: () => Promise<void>;
}

export function taxEntityColumns({
  openEdit,
  toggleStatus,
  reload,
}: TaxEntityColumnsArgs): TableColumnsType<TaxEntity> {
  const columns: TableColumnsType<TaxEntity> = [
    { title: '编码', dataIndex: 'code', width: 120 },
    { title: '名称', dataIndex: 'name', width: 200 },
    {
      title: '类型',
      dataIndex: 'taxpayerType',
      width: 120,
      render: (value: TaxpayerType) => (value === 'general' ? '一般纳税人' : '小规模'),
    },
    { title: '销项税率', dataIndex: 'defaultOutputRate', width: 100, render: (v: number) => `${v}%` },
    { title: '进项税率', dataIndex: 'defaultInputRate', width: 100, render: (v: number) => `${v}%` },
    {
      // T9：城建税率原先连列都不显示 —— 于是"底稿报主体未配置城建税率"时，
      // 使用者在这个页面上看不到任何线索。
      title: '城建税率',
      dataIndex: 'urbanMaintRate',
      width: 100,
      render: (v: number | null | undefined) =>
        v === null || v === undefined ? (
          <span className="text-warning">未配置</span>
        ) : (
          `${v}%`
        ),
    },
    {
      // T9：申报周期（小规模免征额度判定的必要要件）
      title: '申报周期',
      dataIndex: 'vatFilingCycle',
      width: 110,
      render: (v: string | null | undefined) =>
        v === 'monthly' ? '按月' : v === 'quarterly' ? '按季' : '未声明',
    },
    {
      title: '默认',
      dataIndex: 'isDefault',
      width: 80,
      render: (value: boolean) => (value ? '是' : ''),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => (value === 'active' ? '启用' : '停用'),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      render: (_value, row) => (
        <CanCapabilityWrite capability="tax_entity">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                masterDataApi
                  .setDefaultTaxEntity(row.id)
                  .then(() => reload())
                  .catch((err: unknown) =>
                    toast.error(getApiErrorMessage(err, '设置失败'))
                  )
              }
            >
              设为默认
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void toggleStatus(row)}
            >
              {row.status === 'active' ? '停用' : '启用'}
            </Button>
          </div>
        </CanCapabilityWrite>
      ),
    },
  ];

  return columns;
}
