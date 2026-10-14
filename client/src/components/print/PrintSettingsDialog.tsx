import React, { useCallback, useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import type { PrintOffset, PrintPack } from '@shared/api.interface';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Switch } from '@client/src/components/ui/switch';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

import PrintDocument from './PrintDocument';
import PrintDocumentHost from './PrintDocumentHost';
import { PRINT_OFFSET_LIMIT_MM, readPrintPreference, writePrintPreference } from './print-storage';

/** 等待字体/Logo 就绪的最长时间：超时也要能把纸打出来，不能卡住用户 */
const PRINT_READY_TIMEOUT_MS = 2000;

/**
 * 打印前的资源等待。
 * 单据上只有 Logo 一张图，字体多为本地字体，正常 0~100ms 内完成；
 * 超时（网络慢/Logo 404）后仍继续打印，只把失败交给调用方提示。
 */
async function waitForPrintAssets(host: HTMLElement | null): Promise<void> {
  const fontReady =
    typeof document !== 'undefined' && 'fonts' in document
      ? document.fonts.ready.then(() => undefined)
      : Promise.resolve();
  const images = host ? Array.from(host.querySelectorAll('img')) : [];
  const imagesReady = Promise.all(
    images.map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
    ),
  ).then(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    window.setTimeout(resolve, PRINT_READY_TIMEOUT_MS);
  });
  await Promise.race([Promise.all([fontReady, imagesReady]).then(() => undefined), timeout]);
}

interface PrintSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打印数据包；为 null 时对话框只显示禁用态（数据未加载完） */
  pack: PrintPack | null;
  /** 数据包组装失败原因（例如品牌接口失败），优先于 pack 渲染 */
  error?: string | null;
}

/**
 * C-06 打印设置 / 套打对齐对话框。
 *
 * 交互：右上方「打印」按钮 → 本对话框 → 调整套打偏移（mm）→ 「预览并打印」。
 * 偏移按单据类型持久化到 localStorage（`erp-print-pref:{kind}`）。
 * 打印用 `window.print()` + `print.css`，不依赖 react-to-print（仓库未安装该依赖）。
 */
const PrintSettingsDialog: React.FC<PrintSettingsDialogProps> = ({
  open,
  onOpenChange,
  pack,
  error = null,
}) => {
  const kind = pack?.kind ?? null;
  const [offset, setOffset] = useState<PrintOffset>({ topMm: 0, leftMm: 0, overlay: false });
  const [printing, setPrinting] = useState(false);

  // 打开时按单据类型载入已保存的偏移（每个单据类型独立记忆对齐值）
  useEffect(() => {
    if (!open || !kind) return;
    setOffset(readPrintPreference(kind).offset);
  }, [open, kind]);

  const persist = useCallback(
    (next: PrintOffset) => {
      setOffset(next);
      if (!kind) return;
      const saved = writePrintPreference({ kind, offset: next });
      if (!saved) {
        toast.warning('套打偏移无法保存到本机（浏览器禁用了本地存储），本次打印仍按当前值生效');
      }
    },
    [kind],
  );

  const previewPack = pack;

  const handlePrint = useCallback(async () => {
    if (!previewPack) {
      toast.error('打印数据尚未就绪，请稍后重试');
      return;
    }
    setPrinting(true);
    try {
      // 等 Logo/字体就绪再调起打印，避免纸上出现空图位；超时也会继续
      const stage = document.querySelector<HTMLElement>('.print-root .print-page');
      await waitForPrintAssets(stage);
      window.print();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '调起打印失败，请检查浏览器打印权限'));
    } finally {
      setPrinting(false);
    }
  }, [previewPack]);

  const blocked = Boolean(error) || !previewPack;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>打印与套打设置</DialogTitle>
          <DialogDescription>
            套打偏移用于对齐预印表单：以纸张左上角为基准，正值表示内容向右/向下移动（单位 mm）。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        ) : null}
        {!error && !previewPack ? (
          <p className="text-sm text-muted-foreground">正在准备打印数据…</p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="print-offset-top">上边距偏移（mm）</Label>
            <Input
              id="print-offset-top"
              type="number"
              step={0.5}
              min={-PRINT_OFFSET_LIMIT_MM}
              max={PRINT_OFFSET_LIMIT_MM}
              value={String(offset.topMm)}
              disabled={blocked}
              onChange={(e) => persist({ ...offset, topMm: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="print-offset-left">左边距偏移（mm）</Label>
            <Input
              id="print-offset-left"
              type="number"
              step={0.5}
              min={-PRINT_OFFSET_LIMIT_MM}
              max={PRINT_OFFSET_LIMIT_MM}
              value={String(offset.leftMm)}
              disabled={blocked}
              onChange={(e) => persist({ ...offset, leftMm: Number(e.target.value) })}
            />
          </div>
          <div className="flex items-center gap-2 self-end pb-2">
            <Switch
              id="print-overlay-mode"
              checked={offset.overlay}
              disabled={blocked}
              onCheckedChange={(checked: boolean) => persist({ ...offset, overlay: checked })}
            />
            <Label htmlFor="print-overlay-mode">套打模式</Label>
          </div>
          <div className="flex items-center gap-2 self-end pb-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() => persist({ topMm: 0, leftMm: 0, overlay: offset.overlay })}
            >
              重置偏移
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          套打模式会隐藏 Logo、公司名与数据来源说明等装饰，避免与表单上的预印内容重叠。
        </p>

        {previewPack ? (
          <div className="print-preview-stage overflow-x-auto rounded-md border">
            <PrintDocument pack={previewPack} offset={offset} />
          </div>
        ) : null}

        {/* 真正被打印的节点：portal 到 body，屏幕上隐藏，仅 @media print 显示 */}
        <PrintDocumentHost pack={previewPack} offset={offset} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button type="button" disabled={blocked || printing} onClick={() => void handlePrint()}>
            <Printer className="h-4 w-4" />
            {printing ? '正在调起打印…' : '预览并打印'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PrintSettingsDialog;
