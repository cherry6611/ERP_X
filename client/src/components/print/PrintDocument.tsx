import React from 'react';
import type { PrintOffset, PrintPack } from '@shared/api.interface';
import { withBasePath } from '@client/src/utils/base-path';

import './print.css';
import { rowCells, totalInWords } from './print-pack';

interface PrintDocumentProps {
  pack: PrintPack;
  /** 套打偏移；缺省按非套打渲染 */
  offset?: PrintOffset;
}

/**
 * C-06 单据打印件渲染器（纯展示，无副作用）。
 *
 * 布局约定：抬头 → 元信息 → 明细表 → 合计（含人民币大写）→ 附加字段 → 条款 → 签章栏 → 页脚。
 * 所有排版规则都在 `print.css` 里（A4 / 隐藏外壳 / 表头重复 / 行不跨页 / 套打偏移）。
 */
const PrintDocument: React.FC<PrintDocumentProps> = ({ pack, offset }) => {
  const pageStyle: React.CSSProperties = {
    ['--print-offset-top' as string]: `${offset?.topMm ?? 0}mm`,
    ['--print-offset-left' as string]: `${offset?.leftMm ?? 0}mm`,
  };

  return (
    <div
      className="print-page"
      data-overlay={offset?.overlay ? 'true' : 'false'}
      data-print-kind={pack.kind}
      data-print-code={pack.code}
      style={pageStyle}
    >
      <header className="print-doc-header">
        {pack.header.logoUrl ? (
          <img
            className="print-doc-logo"
            src={withBasePath(pack.header.logoUrl)}
            alt={pack.header.brandName}
          />
        ) : null}
        <span className="print-doc-brand">{pack.header.brandName}</span>
        <h1 className="print-doc-title">{pack.header.title}</h1>
      </header>

      {pack.header.subtitle ? (
        <p className="print-doc-subtitle">{pack.header.subtitle}</p>
      ) : null}

      {pack.meta.length > 0 ? (
        <div className="print-meta">
          {pack.meta.map((field, index) => (
            <span key={`${field.label}-${index}`} className="print-meta-item">
              <span className="print-meta-label">{field.label}：</span>
              <span>{field.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {pack.tableTitle ? <p className="print-table-title">{pack.tableTitle}</p> : null}

      {pack.columns.length > 0 ? (
        <table className="print-table">
          <thead>
            <tr>
              {pack.columns.map((column) => (
                <th
                  key={column.key}
                  className={
                    column.align === 'right'
                      ? 'print-align-right'
                      : column.align === 'center'
                        ? 'print-align-center'
                        : undefined
                  }
                  style={column.widthMm ? { width: `${column.widthMm}mm` } : undefined}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pack.rows.length > 0 ? (
              pack.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {rowCells(row, pack.columns).map((cell, cellIndex) => (
                    <td
                      key={pack.columns[cellIndex]?.key ?? cellIndex}
                      className={
                        pack.columns[cellIndex]?.align === 'right'
                          ? 'print-align-right'
                          : pack.columns[cellIndex]?.align === 'center'
                            ? 'print-align-center'
                            : undefined
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td className="print-align-center" colSpan={pack.columns.length}>
                  无明细
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : null}

      {pack.totals.length > 0 ? (
        <div className="print-totals">
          {pack.totals.map((total) => {
            const words = total.inWords ? totalInWords(total.amount) : null;
            return (
              <React.Fragment key={total.label}>
                <div
                  className={
                    total.emphasize
                      ? 'print-total-row print-total-row-emphasis'
                      : 'print-total-row'
                  }
                >
                  <span>{total.label}：</span>
                  <span className="print-total-amount">
                    {total.amount.toLocaleString('zh-CN', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                {words ? (
                  <div className="print-in-words">
                    <span>人民币（大写）：</span>
                    <span>{words.text}</span>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      ) : null}

      {pack.extraFields.length > 0 ? (
        <div className="print-extra">
          {pack.extraFields.map((field, index) => (
            <span key={`${field.label}-${index}`} className="print-meta-item">
              <span className="print-meta-label">{field.label}：</span>
              <span>{field.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {pack.clauses.length > 0 ? (
        <div className="print-clauses">
          {pack.clauses.map((clause, index) => (
            <p key={index} className="print-clauses-item">
              {clause}
            </p>
          ))}
        </div>
      ) : null}

      {pack.signatures.length > 0 ? (
        <div className="print-signatures">
          {pack.signatures.map((slot) => (
            <div key={slot.slot} className="print-signature-slot">
              <span className="print-signature-label">
                {slot.label}：{slot.signer ?? ''}
              </span>
              <span className="print-signature-line" />
            </div>
          ))}
        </div>
      ) : null}

      <footer className="print-doc-footer">
        <span className="print-doc-source-note">{pack.sourceNote ?? ''}</span>
        <span>{pack.footerNote}</span>
      </footer>
    </div>
  );
};

export default PrintDocument;
