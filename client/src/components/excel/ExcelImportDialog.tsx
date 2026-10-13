import React, { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { logger } from '@client/src/platform/logger';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@client/src/components/ui/table';
import {
  downloadImportTemplate,
  extractErrorMessage,
  parseXlsxFirstSheet,
} from './excel-utils';

/** 导入模板列定义（与导出/模板的中文表头一致） */
export interface ExcelImportColumnDef {
  header: string;
  required?: boolean;
}

/** 页面级解析结果：dto 为 null 表示该行不合法，errors 为行内错误 */
export interface ParsedRowResult<TDto> {
  dto: TDto | null;
  errors: string[];
}

interface ImportRowState<TDto> {
  raw: Record<string, string>;
  key: string;
  errors: string[];
  dto: TDto | null;
  status: 'pending' | 'success' | 'failed';
  resultMessage: string;
}

export interface ExcelImportDialogProps<TDto> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 实体中文名，用于错误文案与 Dialog 标题 */
  entityName: string;
  templateFilename: string;
  columns: ExcelImportColumnDef[];
  /** 将一行 Excel 原始数据（中文表头 -> 字符串）映射为创建 DTO，并做必填/枚举校验 */
  parseRow: (raw: Record<string, string>) => ParsedRowResult<TDto>;
  /** 行唯一标识（用于与已列表数据、文件内部的重复校验），空串表示无法判重 */
  rowKey: (raw: Record<string, string>) => string;
  /** 已列表数据的唯一标识集合 */
  existingKeys: string[];
  /** 逐行调用已有创建接口 */
  createRow: (dto: TDto) => Promise<void>;
  /** 导入结束后的回调（用于刷新列表） */
  onImportFinished: () => void | Promise<void>;
}

const PREVIEW_ROW_LIMIT = 10;

export function ExcelImportDialog<TDto>(props: ExcelImportDialogProps<TDto>) {
  const {
    open,
    onOpenChange,
    entityName,
    templateFilename,
    columns,
    parseRow,
    rowKey,
    existingKeys,
    createRow,
    onImportFinished,
  } = props;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState<ImportRowState<TDto>[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const validCount: number = (rows ?? []).filter(
    (row: ImportRowState<TDto>) => row.dto !== null && row.status === 'pending',
  ).length;
  const invalidCount: number = (rows ?? []).length - validCount;

  const resetState = () => {
    setRows(null);
    setFileName('');
    setSubmitted(false);
    setSubmitting(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && submitting) return; // 导入进行中禁止关闭
    if (next) resetState();
    onOpenChange(next);
  };

  const handleParse = async (file: File) => {
    try {
      const rawRows: Record<string, string>[] = await parseXlsxFirstSheet(file);
      const existing: Set<string> = new Set(existingKeys);
      const seen: Map<string, number> = new Map();
      const nextRows: ImportRowState<TDto>[] = rawRows.map(
        (raw: Record<string, string>, index: number) => {
          const parsed: ParsedRowResult<TDto> = parseRow(raw);
          const errors: string[] = [...parsed.errors];
          const key: string = rowKey(raw);
          if (key) {
            if (existing.has(key)) {
              errors.push(`${entityName}「${key}」已存在于当前列表`);
            } else if (seen.has(key)) {
              errors.push(`与第 ${seen.get(key)} 行的「${key}」在文件内重复`);
            } else {
              seen.set(key, index + 1);
            }
          }
          return {
            raw,
            key,
            errors,
            dto: errors.length > 0 ? null : parsed.dto,
            status: 'pending',
            resultMessage: '',
          };
        },
      );
      setRows(nextRows);
      setFileName(file.name);
      setSubmitted(false);
    } catch (error) {
      logger.error('Excel 导入解析失败', error);
      toast.error('文件解析失败，请检查是否为有效的 Excel 文件');
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file: File | undefined = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void handleParse(file);
  };

  const handleSelectFile = () => {
    fileInputRef.current?.click();
  };

  const handleDownloadTemplate = () => {
    downloadImportTemplate(
      templateFilename,
      columns.map((col: ExcelImportColumnDef) => col.header),
    );
  };

  const handleConfirm = async () => {
    if (!rows || submitting || validCount === 0) return;
    setSubmitting(true);
    setSubmitted(true);
    const working: ImportRowState<TDto>[] = [...rows];
    let successCount = 0;
    let failCount = 0;
    for (let index = 0; index < working.length; index += 1) {
      const row: ImportRowState<TDto> = working[index];
      if (row.dto === null) continue; // 校验不通过的行禁止导入
      try {
        await createRow(row.dto);
        working[index] = { ...row, status: 'success', resultMessage: '导入成功' };
        successCount += 1;
      } catch (error) {
        working[index] = {
          ...row,
          status: 'failed',
          resultMessage: extractErrorMessage(error, '创建失败'),
        };
        failCount += 1;
      }
      setRows([...working]);
    }
    setSubmitting(false);
    if (failCount === 0) {
      toast.success(`${entityName}导入完成：成功 ${successCount} 条`);
    } else {
      toast.error(`${entityName}导入完成：成功 ${successCount} 条 / 失败 ${failCount} 条`);
    }
    await onImportFinished();
  };

  const displayRows: ImportRowState<TDto>[] = submitted
    ? (rows ?? [])
    : (rows ?? []).slice(0, PREVIEW_ROW_LIMIT);

  const renderResultCell = (row: ImportRowState<TDto>) => {
    if (row.status === 'success') {
      return <span className="text-success">导入成功</span>;
    }
    if (row.status === 'failed') {
      return <span className="text-destructive">{row.resultMessage}</span>;
    }
    if (row.errors.length > 0) {
      return <span className="text-destructive">{row.errors.join('；')}</span>;
    }
    return <span className="text-muted-foreground">校验通过</span>;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>导入{entityName}</DialogTitle>
        </DialogHeader>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={handleFileChange}
        />
        {rows === null ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              请选择 Excel 文件（第一个工作表），列名需与模板一致；也可先下载模板填写。
            </p>
            <div className="flex items-center gap-3">
              <Button onClick={handleSelectFile}>
                <Upload className="h-4 w-4" />
                选择文件
              </Button>
              <Button variant="outline" onClick={handleDownloadTemplate}>
                <FileSpreadsheet className="h-4 w-4" />
                下载模板
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{fileName}</span>
                <span className="text-sm text-muted-foreground">
                  共解析 {rows.length} 行，校验通过 {validCount} 行
                  {invalidCount > 0 ? `，存在错误 ${invalidCount} 行` : ''}
                  {!submitted && rows.length > PREVIEW_ROW_LIMIT
                    ? `（预览前 ${PREVIEW_ROW_LIMIT} 行）`
                    : ''}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={handleSelectFile}
              >
                重新选择文件
              </Button>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">序号</TableHead>
                    {columns.map((col: ExcelImportColumnDef) => (
                      <TableHead key={col.header}>
                        {col.header}
                        {col.required ? (
                          <span aria-hidden="true" className="text-destructive">
                            *
                          </span>
                        ) : null}
                      </TableHead>
                    ))}
                    <TableHead>校验 / 结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length + 2}
                        className="text-muted-foreground py-6 text-center"
                      >
                        未解析到数据行，请检查文件内容
                      </TableCell>
                    </TableRow>
                  ) : (
                    displayRows.map((row: ImportRowState<TDto>, index: number) => (
                      <TableRow key={index}>
                        <TableCell>{index + 1}</TableCell>
                        {columns.map((col: ExcelImportColumnDef) => (
                          <TableCell key={col.header}>{row.raw[col.header] ?? ''}</TableCell>
                        ))}
                        <TableCell className="whitespace-normal">
                          {renderResultCell(row)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <DialogFooter>
          {rows === null ? (
            <Button variant="outline" onClick={handleDownloadTemplate}>
              <FileSpreadsheet className="h-4 w-4" />
              下载模板
            </Button>
          ) : submitted ? (
            <Button variant="outline" disabled={submitting} onClick={() => handleOpenChange(false)}>
              关闭
            </Button>
          ) : (
            <>
              <Button variant="ghost" disabled={submitting} onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={submitting || validCount === 0}
                onClick={() => void handleConfirm()}
              >
                {submitting
                  ? '导入中…'
                  : validCount === 0
                    ? '无可导入行'
                    : `确认导入（${validCount} 条）`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
