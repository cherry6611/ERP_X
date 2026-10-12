import ExcelJS from 'exceljs';

/** Excel 导出列定义：header 为中文表头，value 取出该列的值（金额/数值列返回 number） */
export interface ExcelSheetColumn<TRow> {
  header: string;
  value: (row: TRow) => string | number | null | undefined;
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

/** 将当前已加载数据导出为 .xlsx 并触发下载 */
export function exportRowsToXlsx<TRow>(
  filename: string,
  sheetName: string,
  columns: ExcelSheetColumn<TRow>[],
  rows: TRow[],
): void {
  const header: string[] = columns.map((col: ExcelSheetColumn<TRow>) => col.header);
  const body: (string | number)[][] = rows.map((row: TRow) =>
    columns.map((col: ExcelSheetColumn<TRow>) => {
      const cell = col.value(row);
      return cell === null || cell === undefined ? '' : cell;
    }),
  );
  void (async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31) || 'Sheet1');
    sheet.addRow(header);
    for (const line of body) sheet.addRow(line);
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBuffer(buffer, filename);
  })();
}

/** 下载仅含中文表头的导入模板 */
export function downloadImportTemplate(filename: string, headers: string[]): void {
  void (async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('模板');
    sheet.addRow(headers);
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBuffer(buffer, filename);
  })();
}

/**
 * 解析 xlsx 文件的第一个 sheet，返回以中文表头为 key 的行记录。
 * 单元格值统一转成字符串，空单元格为 ''。
 */
export async function parseXlsxFirstSheet(file: File): Promise<Record<string, string>[]> {
  const buffer: ArrayBuffer = await file.arrayBuffer();
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
