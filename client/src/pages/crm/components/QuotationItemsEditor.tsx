/**
 * 报价单明细行编辑器（§5.9 / F8，从 `QuotationFormDialog.tsx` 拆出）。
 *
 * ⚠️ **明细状态留在父组件**，本组件是无状态的受控视图。原因（不是偷懒）：
 *   · 父组件的提交处理器要**校验**每条明细并据此构造 `CreateQuotationDto`；
 *   · 父组件的「打开/切换编辑对象」重置 `useEffect` 要**整体重建**明细数组
 *     （含每行 `rowKey` 行身份）；
 *   · 父组件的「云文档解析」`applyDraft` 要**覆盖**明细数组；
 *   · 合计 `computeQuotationTotals(items, …)` 也读同一份明细。
 * 若把 state 搬进来，就要把明细再复制一份回父组件 —— 两份迟早分叉，
 * 而这里分叉的代价是**报价金额**。因此按「父组件 state → props」的方式拆，
 * prop 名与块内标识符保持同名（`items` / `addItem` / `removeItem` / `updateItem`），
 * 块内 JSX **一行未改**。
 *
 * `toNum` 与 `QuotationRow` 随明细逻辑一起移入 `./quotation-form`（纯逻辑，另有单测）。
 */
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { toNum, type QuotationRow } from './quotation-form';

interface QuotationItemsEditorProps {
  /** 父组件持有的明细行（含 rowKey 行身份） */
  items: QuotationRow[];
  /** 父组件的 `addItem`（同名 prop，块内 JSX 无需改动） */
  addItem: () => void;
  /** 父组件的 `removeItem` */
  removeItem: (index: number) => void;
  /** 父组件的 `updateItem` */
  updateItem: (index: number, patch: Partial<QuotationRow>) => void;
}

const QuotationItemsEditor: React.FC<QuotationItemsEditorProps> = ({
  items,
  addItem,
  removeItem,
  updateItem,
}) => {
    /*
      a11y（§5.10 / P2-3）：`明细行` 是下方明细表格 + 「添加明细」
      按钮这一**组控件**的标题，不对应任何单一表单控件 ——
      加 `htmlFor` 只能挂到表里第一个输入框上，语义是错的。
      按 ARIA 分组处理：容器 `role="group"` + `aria-labelledby`。
    */
  return (
    <div
      className="space-y-2"
      role="group"
      aria-labelledby="quotation-items-label"
    >
      <div className="flex items-center justify-between">
        <Label id="quotation-items-label">明细行</Label>
        <Button type="button" variant="outline" size="sm" onClick={addItem}>
          <Plus className="h-4 w-4" />
          添加明细
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">服务项名称</th>
              <th className="w-20 py-1 pr-2 font-medium">单位</th>
              <th className="w-20 py-1 pr-2 font-medium">数量</th>
              <th className="w-28 py-1 pr-2 font-medium">单价</th>
              <th className="w-20 py-1 pr-2 font-medium">行折扣%</th>
              <th className="w-28 py-1 pr-2 font-medium">预估单位成本</th>
              <th className="py-1 pr-2 font-medium">备注</th>
              <th className="w-10 py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {items.map((row: QuotationRow, index: number) => (
              <tr key={row.rowKey} className="border-b">
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    value={row.itemName}
                    onChange={(e) =>
                      updateItem(index, { itemName: e.target.value })
                    }
                    placeholder="服务项名称"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    value={row.unit}
                    onChange={(e) => updateItem(index, { unit: e.target.value })}
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    type="number"
                    min={0}
                    value={String(row.quantity)}
                    onChange={(e) =>
                      updateItem(index, { quantity: toNum(e.target.value) })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    type="number"
                    min={0}
                    value={String(row.unitPrice)}
                    onChange={(e) =>
                      updateItem(index, { unitPrice: toNum(e.target.value) })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    type="number"
                    min={0}
                    max={100}
                    value={String(row.discountPct)}
                    onChange={(e) =>
                      updateItem(index, { discountPct: toNum(e.target.value) })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    type="number"
                    min={0}
                    value={String(row.estUnitCost)}
                    onChange={(e) =>
                      updateItem(index, { estUnitCost: toNum(e.target.value) })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    className="h-8"
                    value={row.remark}
                    onChange={(e) => updateItem(index, { remark: e.target.value })}
                  />
                </td>
                <td className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除明细 ${index + 1}`}
                    onClick={() => removeItem(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default QuotationItemsEditor;
