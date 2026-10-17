/**
 * 票据备查簿：按状态 / 按类型的张数与金额两张表（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的**第三段 JSX**（原第 464–518 行）。
 *
 * ⚠️ **行为零变更**：JSX 与原块**逐字相同**，只做了两件事：
 *   ① 整体去一层缩进（8 → 6）；
 *   ② `register` 由父组件经 props 传入（原为页面级 `const { data: register }`）。
 *
 * 条件 `{register && (...)}` 原样保留：本组件**无条件挂载**，数据未到时
 * `register` 为 `null`，渲染结果与拆分前完全一致（不产生任何 DOM）。
 */
import React from 'react';
import { money } from '../note-format';
import type { NoteRegisterResult } from '@shared/api.interface';

interface NotesRegisterLedgerProps {
  /** 备查簿汇总（`GET /api/notes/register`）；未取到时为 `null` */
  register: NoteRegisterResult | null;
}

const NotesRegisterLedger: React.FC<NotesRegisterLedgerProps> = ({
  register,
}) => {
  return (
    <>
      {register && (
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">票据备查簿</h3>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">状态</th>
                    <th className="p-2 text-right font-medium">张数</th>
                    <th className="p-2 text-right font-medium">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {register.byStatus.map((item) => (
                    <tr key={item.status} className="border-t">
                      <td className="p-2">{item.label}</td>
                      <td className="p-2 text-right tabular-nums">
                        {item.count}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {money(item.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">票据类型</th>
                    <th className="p-2 text-right font-medium">张数</th>
                    <th className="p-2 text-right font-medium">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {register.byType.map((item) => (
                    <tr key={item.noteType} className="border-t">
                      <td className="p-2">{item.label}</td>
                      <td className="p-2 text-right tabular-nums">
                        {item.count}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {money(item.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default NotesRegisterLedger;
