import React from 'react';
import { createPortal } from 'react-dom';
import type { PrintOffset, PrintPack } from '@shared/api.interface';

import PrintDocument from './PrintDocument';

interface PrintDocumentHostProps {
  /** 为 null 时不挂载（对话框未打开/数据未就绪） */
  pack: PrintPack | null;
  offset: PrintOffset;
}

/**
 * C-06 打印宿主。
 *
 * 用 `createPortal` 把 `PrintDocument` 直接挂到 `document.body` 下并包一层 `.print-root`：
 *   - 打印时 `print.css` 里 `body > *:not(.print-root) { display: none }` 能干净地
 *     隐藏应用外壳（含 Radix Dialog 的 portal 节点），且不需要给每个弹窗加 print 类；
 *   - 屏幕上 `.print-root` 用内联 `display:none` 隐藏，只有 `@media print` 会把它打开。
 *
 * 之所以不依赖任何打印库：仓库未安装 `react-to-print`（`package.json` 已确认），
 * 且本任务不允许新增依赖。
 */
const PrintDocumentHost: React.FC<PrintDocumentHostProps> = ({ pack, offset }) => {
  if (!pack) return null;
  const container = typeof document === 'undefined' ? null : document.body;
  if (!container) return null;

  return createPortal(
    <div className="print-root" style={{ display: 'none' }} aria-hidden="true">
      <div className="print-preview-stage">
        <PrintDocument pack={pack} offset={offset} />
      </div>
    </div>,
    container,
  );
};

export default PrintDocumentHost;
