import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fetchSimilarItems } from '@client/src/api/semantic';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import type { SemanticBizType, SemanticSimilarItem } from '@shared/api.interface';

export interface SimilarTarget {
  id: string;
  code: string;
  name: string;
}

interface SimilarItemsDialogProps {
  open: boolean;
  onClose: () => void;
  type: SemanticBizType;
  target: SimilarTarget | null;
  onPick?: (item: SemanticSimilarItem) => void;
}

const SimilarItemsDialog: React.FC<SimilarItemsDialogProps> = ({
  open,
  onClose,
  type,
  target,
  onPick,
}) => {
  const [items, setItems] = useState<SemanticSimilarItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || target === null) return;
    let cancelled = false;
    setLoading(true);
    setItems([]);
    fetchSimilarItems(type, target.id)
      .then((result: SemanticSimilarItem[]) => {
        if (!cancelled) setItems(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error('相似记录查询失败', { description: String(error) });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, type, target]);

  const bizLabel = type === 'contract' ? '合同' : '项目';

  return (
    <Dialog
      open={open}
      onOpenChange={(o: boolean) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>找相似{bizLabel}</DialogTitle>
          <DialogDescription>
            {target
              ? `${target.code} ${target.name} 的语义相似${bizLabel}，按内容相似度排序`
              : ''}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">检索中…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            未找到足够相似的{bizLabel}，相似度过低的结果已过滤
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item: SemanticSimilarItem) => (
              <li key={item.id}>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-between px-2 py-2"
                  aria-label={`查看相似${bizLabel} ${item.name}`}
                  onClick={() => onPick?.(item)}
                >
                  <span className="min-w-0 text-left">
                    <span className="truncate text-sm">{item.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{item.code}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    相似度 {(item.similarity * 100).toFixed(1)}%
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default SimilarItemsDialog;
