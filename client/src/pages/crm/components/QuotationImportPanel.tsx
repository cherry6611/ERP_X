/**
 * 报价单「云文档解析 / 多维表格导入」面板（§5.9 / F8，从 `QuotationFormDialog.tsx` 拆出）。
 *
 * ## 为什么搬这一块
 *
 * 这是整个表单里**唯一自带异步状态**的一段：1 个 `useRef` + 7 个 `useState`
 * （云文档链接、解析中、上传中、多维表格记录/勾选/加载中/预览中）、2 个派生布尔值
 * 与 4 个异步处理器。原先它们散在 830 行的主文件里，与明细表、合计、提交处理器
 * 混在一起；搬走后**状态与其唯一使用者同处一文件**。
 *
 * ## ⚠️ 组件必须**常驻挂载**（父组件不能写成 `{!editTarget && <QuotationImportPanel/>}`）
 *
 * 原实现里这些 state 与 `!editTarget ? … : null` 的判定是在**同一个组件**里的：
 * 编辑模式下 JSX 不渲染，但 state 依然存在（不重置）。若改成条件挂载，
 * 编辑→新建来回切换时 `docUrl` / `bitableRecords` / 勾选会被丢掉 —— 那是行为变更。
 * 因此判定移进本组件内部（`return !editTarget ? … : null`），父组件无条件渲染它。
 *
 * ## ⚠️ 多维表格配置探测留在父组件，是有意的
 *
 * `crmApi.getFeishuBitableMeta()` 的 `useEffect` 原先在父组件里位于
 * 「useForm 之后、两个列表查询之前」。React 的 effect 是**子先父后**执行：
 * 若把该 effect 一起搬进来，它会在父组件两个列表查询**之前**发出 ——
 * 请求顺序变了。这里选择把**查询与它的 state 留在父组件**（与本仓
 * `ApTab` → `VendorSettlementDialog` 的分工一致：父组件持有数据查询），
 * 子组件通过 `bitableConfigured` prop 接收结果，于是父组件的 effect 顺序**逐行不变**。
 *
 * ## 行为零变更
 *
 * 除上述两点外，state / 派生值 / 4 个处理器 / JSX 都是原块的**逐字搬运**，
 * 只做了整体去缩进与 `applyDraft` 由父组件以同名 prop 传入。
 */
import React, { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileDown, Loader2, Table2, Upload } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { crmApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { ParsedQuotationDraft, Quotation } from '@shared/api.interface';

interface QuotationImportPanelProps {
  /** 编辑模式下面板不渲染（判定在本组件内部，见文件头 ⚠️） */
  editTarget?: Quotation | null;
  /** 多维表格配置探测结果，父组件持有该查询 */
  bitableConfigured: boolean;
  /** 解析成功后把草稿交回父组件（父组件持有 form 与明细状态） */
  applyDraft: (draft: ParsedQuotationDraft) => void;
}

const QuotationImportPanel: React.FC<QuotationImportPanelProps> = ({
  editTarget,
  bitableConfigured,
  applyDraft,
}) => {
  const [docUrl, setDocUrl] = useState<string>('');
  const [parsing, setParsing] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bitableRecords, setBitableRecords] = useState<
    Array<{ recordId: string; fields: Record<string, unknown> }>
  >([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [bitableLoading, setBitableLoading] = useState(false);
  const [bitablePreviewing, setBitablePreviewing] = useState(false);

  const isValidDocUrl = /\/(docx|docs|wiki|file|sheets)\//i.test(docUrl);
  const showDocFormatError = docUrl.trim() !== '' && !isValidDocUrl;

  const loadBitableRecords = async () => {
    setBitableLoading(true);
    try {
      const res = await crmApi.listFeishuBitableRecords();
      setBitableRecords(res.records);
      setSelectedRecordIds([]);
      if (res.records.length === 0) toast.message('多维表格暂无记录');
    } catch (err) {
      toast.error(getApiErrorMessage(err, '加载多维表格失败'));
    } finally {
      setBitableLoading(false);
    }
  };

  const handleBitablePreview = async () => {
    if (selectedRecordIds.length === 0 || bitablePreviewing) return;
    setBitablePreviewing(true);
    try {
      const draft = await crmApi.previewFeishuBitable(selectedRecordIds);
      applyDraft(draft);
      toast.success('已从多维表格填充，请确认明细');
    } catch (err) {
      toast.error(getApiErrorMessage(err, '预览失败'));
    } finally {
      setBitablePreviewing(false);
    }
  };

  const handleDocParse = async () => {
    if (!isValidDocUrl || parsing) return;
    setParsing(true);
    try {
      const draft: ParsedQuotationDraft = await crmApi.parseQuotationDoc(docUrl);
      applyDraft(draft);
      setDocUrl('');
      toast.success('解析成功，请确认明细');
    } catch (err) {
      toast.error(getApiErrorMessage(err, '解析失败，请稍后重试'));
    } finally {
      setParsing(false);
    }
  };

  const handleFileParse = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const draft = await crmApi.parseQuotationFile(file);
      applyDraft(draft);
      toast.success('本地表格解析成功，请确认明细');
    } catch (err) {
      toast.error(getApiErrorMessage(err, '本地文件解析失败'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return !editTarget ? (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <FileDown className="h-4 w-4 text-muted-foreground" />
        <Label htmlFor="quotation-doc-url">云文档解析</Label>
        <span className="text-xs text-muted-foreground">
          支持 /docx/、/docs/、/wiki/、/sheets/；/file/ 附件与本地上传支持
          .docx/.xlsx/.txt/.csv（飞书链接需分享给应用可读）
        </span>
      </div>
      <div className="flex items-start gap-2">
        <Input
          id="quotation-doc-url"
          placeholder="https://xxx.feishu.cn/sheets/xxxx 或 /docx/…"
          value={docUrl}
          onChange={(e) => setDocUrl(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleDocParse()}
          disabled={!isValidDocUrl || parsing}
        >
          {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {parsing ? '解析中…' : '解析并填充'}
        </Button>
      </div>
      {showDocFormatError ? (
        <p className="text-sm text-destructive">
          链接格式不正确，需包含 /docx/、/docs/、/wiki/、/sheets/ 或 /file/ 路径
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.txt,.docx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            void handleFileParse(e.target.files?.[0]);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading || parsing}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {uploading ? '上传解析中…' : '上传本地表格'}
        </Button>
        <span className="text-xs text-muted-foreground">
          本地 .xlsx / .csv / .txt / .docx
        </span>
      </div>
      {bitableConfigured ? (
        /*
         * a11y（§5.10 / P2-3）：`多维表格导入` 不是某个控件的标签，
         * 而是这一组控件（加载/预览按钮 + 记录勾选列表）的**组标题** ——
         * `htmlFor` 在这里没有可指向的单一控件，硬塞一个会指向错误的元素。
         * 因此按 ARIA 的分组语义处理：容器 `role="group"` +
         * `aria-labelledby` 指向标题自身的 id。
         */
        <div
          className="mt-3 space-y-2 border-t pt-3"
          role="group"
          aria-labelledby="quotation-bitable-import-label"
        >
          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-muted-foreground" />
            <Label id="quotation-bitable-import-label">
              多维表格导入
            </Label>
            <span className="text-xs text-muted-foreground">
              勾选记录后预览填充明细
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bitableLoading}
              onClick={() => void loadBitableRecords()}
            >
              {bitableLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              加载记录
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedRecordIds.length === 0 || bitablePreviewing}
              onClick={() => void handleBitablePreview()}
            >
              {bitablePreviewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              预览并填充
            </Button>
          </div>
          {bitableRecords.length > 0 ? (
            <ul className="max-h-36 space-y-1 overflow-y-auto rounded border bg-background p-2 text-sm">
              {bitableRecords.map((rec) => {
                const label =
                  Object.values(rec.fields)
                    .map((v) => {
                      if (typeof v === 'string' || typeof v === 'number') return String(v);
                      return '';
                    })
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(' · ') || rec.recordId;
                return (
                  <li key={rec.recordId} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedRecordIds.includes(rec.recordId)}
                      onChange={(e) => {
                        setSelectedRecordIds((prev) =>
                          e.target.checked
                            ? [...prev, rec.recordId]
                            : prev.filter((id) => id !== rec.recordId),
                        );
                      }}
                    />
                    <span className="truncate">{label}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;
};

export default QuotationImportPanel;
