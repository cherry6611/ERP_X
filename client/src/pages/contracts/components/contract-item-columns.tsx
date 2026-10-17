/**
 * 「合同明细」表的列定义（§5.9 / F8 拆分第二轮）。
 *
 * 明细表的列定义原先**内联在 JSX 属性里**（`<Table columns={[ … ]} />`，66 行，
 * 是组件主文件里最大的一块内联结构）：`render` 里既有 `<div>` + `formatTaxSplitLine`
 * 的展示，也有删除按钮的整段 `confirmDanger` + `deleteContractItem` + `load()`
 * 闭包。抽成工厂函数后，表格本身只剩 `columns={itemColumns}`。
 *
 * ⚠️ **行为零变更**：数组字面量逐字搬运，只做了三件事 ——
 *   ① 整体去掉三层缩进（内联在属性里时是 18 空格起）；
 *   ② `columns={[` 改为函数体内的 `const itemColumns: TableColumnsType<ContractItem> = [`，
 *      函数末尾加 `return itemColumns;`；
 *   ③ 闭包捕获的两个组件层变量改为入参（**同名**，故 `render` 体一个字符未动）：
 *      · `detail` —— 原来读 `detail.status`（按钮显隐）与 `detail.id`（删除目标）
 *      · `load` → 入参 `onDeleted`：`await load()` 改为 `await onDeleted()`，
 *        `ContractDetailBody` 传入的就是 `load`
 * 列头文案、宽度、`dataIndex`、`render` 全部未动。
 *
 * ## 删除按钮的显隐条件（原样保留）
 *
 * `detail.status === 'draft' ? … : null` 是**服务端口径**：明细只能在草稿阶段删
 * （服务端 `contract-items.service.ts` 校验合同状态）。这条判断与 `<CanCapabilityWrite
 * capability="crm_write">` 一起构成"前端不渲染点了必然 403 的按钮"，本轮未改。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { contractsApi } from '@client/src/api';
import type { ContractItem } from '@client/src/api/contracts';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import { toast } from 'sonner';
import type { ContractDetail } from '@shared/api.interface';

interface ContractItemColumnsArgs {
  /** 当前合同详情（删除按钮按 `detail.status === 'draft'` 显隐，并取 `detail.id`） */
  detail: ContractDetail;
  /** 删除成功后重取详情与明细（父组件传入的就是 `load`） */
  onDeleted: () => void | Promise<void>;
}

export function contractItemColumns({
  detail,
  onDeleted,
}: ContractItemColumnsArgs): TableColumnsType<ContractItem> {
  const itemColumns: TableColumnsType<ContractItem> = [
    { title: '序号', dataIndex: 'seq', width: 60 },
    { title: '名称', dataIndex: 'itemName' },
    { title: '数量', dataIndex: 'quantity', width: 80 },
    {
      title: '含税单价',
      dataIndex: 'unitPrice',
      width: 110,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '税率',
      dataIndex: 'taxRate',
      width: 70,
      render: (v: number) => `${v}%`,
    },
    {
      title: '含税金额',
      dataIndex: 'amount',
      width: 180,
      render: (v: number, row: ContractItem) => (
        <div>
          <div>{formatMoney(v)}</div>
          <div className="text-xs text-muted-foreground">
            {formatTaxSplitLine(v, row.taxRate)}
          </div>
        </div>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_value, row: ContractItem) =>
        detail.status === 'draft' ? (
          <CanCapabilityWrite capability="crm_write">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void (async () => {
                  const ok = await confirmDanger(
                    `确认删除明细「${row.itemName}」？此操作不可恢复。`,
                    { title: '确认删除' },
                  );
                  if (!ok) return;
                  try {
                    await contractsApi.deleteContractItem(
                      detail.id,
                      row.id,
                    );
                    await onDeleted();
                  } catch (err: unknown) {
                    toast.error(
                      getApiErrorMessage(err, '删除失败'),
                    );
                  }
                })();
              }}
            >
              删除
            </Button>
          </CanCapabilityWrite>
        ) : null,
    },
  ];
  return itemColumns;
}
