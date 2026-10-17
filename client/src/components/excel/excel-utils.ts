/**
 * F10：**exceljs 必须动态导入**。
 *
 * ## 问题
 *
 * 原实现是顶层 `import ExcelJS from 'exceljs'`，而本文件被三个**高频列表页**
 * 静态引用（`CustomersPage.tsx:53`、`hr/components/EmployeePanel.tsx:14`、
 * `SuppliersPage.tsx:37`）。于是打开"客户列表"这一个动作就要下载整个
 * Excel 引擎 —— 实测 `excel-utils` chunk **909 KB**（gzip 257 KB），
 * 而这 909 KB 里只有"点导出/导入"才用得到。
 *
 * ## 修法
 *
 * 把 `exceljs` 改成**函数内动态导入**（与 `components/EChart.tsx` 同一策略）。
 * 这样 `excel-utils` chunk 只保留几十行的纯逻辑，
 * 真正的 Excel 引擎只在用户点「导出」或「导入」时才拉取。
 *
 * ⚠️ 不要在文件顶层写 `const ExcelJS = await import('exceljs')` 之类的
 * 模块级缓存 —— 那会把动态导入重新变回静态依赖（打包器会为顶层 await 建立
 * 静态引用），等于没改。缓存放在 `loadExcelJs()` 里，由运行时首次调用触发。
 */

/** Excel 导出列定义：header 为中文表头，value 取出该列的值（金额/数值列返回 number） */
export interface ExcelSheetColumn<TRow> {
  header: string;
  value: (row: TRow) => string | number | null | undefined;
}

/** exceljs 命名空间类型（`import type` 编译期擦除，不产生运行时依赖） */
type ExcelJsModule = typeof import('exceljs');

let excelJsCache: ExcelJsModule | null = null;
let excelJsLoading: Promise<ExcelJsModule> | null = null;

/**
 * 按需加载 exceljs（模块级缓存：同一会话只下载一次）。
 *
 * 失败时向上抛出，由调用方决定如何提示（各调用点已用 `toast` 兜底）。
 */
async function loadExcelJs(): Promise<ExcelJsModule> {
  if (excelJsCache) return excelJsCache;
  if (!excelJsLoading) {
    excelJsLoading = import('exceljs')
      .then((mod) => {
        excelJsCache = mod;
        return mod;
      })
      .catch((error: unknown) => {
        // 允许重试：失败后清空 in-flight，下次点击会重新拉取
        excelJsLoading = null;
        throw error;
      });
  }
  return excelJsLoading;
}

function downloadBuffer(buffer: ArrayBuffer | Uint8Array, filename: string): void {
  const source: Uint8Array =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const blob = new Blob([copy.buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url: string = URL.createObjectURL(blob);
  const link: HTMLAnchorElement = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 将当前已加载数据导出为 .xlsx 并触发下载。
 *
 * 返回值语义（F10 变更）：原实现 `void` 掉整个异步流程，导出失败**静默无感**；
 * 现在返回 Promise，调用方可 `await` 并提示失败。
 * 既有调用点若不 `await` 也不会报错（向后兼容），但新代码应 await。
 */
export async function exportRowsToXlsx<TRow>(
  filename: string,
  sheetName: string,
  columns: ExcelSheetColumn<TRow>[],
  rows: TRow[],
): Promise<void> {
  const header: string[] = columns.map((col: ExcelSheetColumn<TRow>) => col.header);
  const body: (string | number)[][] = rows.map((row: TRow) =>
    columns.map((col: ExcelSheetColumn<TRow>) => {
      const cell = col.value(row);
      return cell === null || cell === undefined ? '' : cell;
    }),
  );
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31) || 'Sheet1');
  sheet.addRow(header);
  for (const line of body) sheet.addRow(line);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBuffer(buffer, filename);
}

/** 下载仅含中文表头的导入模板 */
export async function downloadImportTemplate(
  filename: string,
  headers: string[],
): Promise<void> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('模板');
  sheet.addRow(headers);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBuffer(buffer, filename);
}

/**
 * 解析 xlsx 文件的第一个 sheet，返回以中文表头为 key 的行记录。
 * 单元格值统一转成字符串，空单元格为 ''。
 */
export async function parseXlsxFirstSheet(file: File): Promise<Record<string, string>[]> {
  const buffer: ArrayBuffer = await file.arrayBuffer();
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber] = cell.value === null || cell.value === undefined ? '' : String(cell.value);
  });
  const records: Record<string, string>[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string> = {};
    headers.forEach((header: string, index: number) => {
      if (!header) return;
      const value = row.getCell(index).value;
      record[header] = value === null || value === undefined ? '' : String(value);
    });
    records.push(record);
  });
  return records;
}

/** 从接口/请求异常中提取可读错误信息，失败时回退 fallback */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object' && 'response' in error) {
    const response: unknown = error.response;
    if (response !== null && typeof response === 'object' && 'data' in response) {
      const data: unknown = response.data;
      if (data !== null && typeof data === 'object' && 'message' in data) {
        const message: unknown = data.message;
        if (typeof message === 'string' && message) return message;
      }
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
