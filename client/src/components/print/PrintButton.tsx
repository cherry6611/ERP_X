import React, { useCallback, useState } from 'react';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import type { BrandConfig, PrintPack } from '@shared/api.interface';
import { Button } from '@client/src/components/ui/button';
import { getBrand } from '@client/src/api/settings';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

import PrintSettingsDialog from './PrintSettingsDialog';
import type { PrintPackSeed } from './print-pack';
import { buildPrintPack } from './print-pack';

interface PrintButtonProps {
  /** 各单据详情页提供业务字段的组件函数；`brand` 来自 settings 品牌接口 */
  build: (brand: BrandConfig | null) => PrintPackSeed | null;
  label?: string;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  disabled?: boolean;
  className?: string;
  /** 表格行内使用时置 false，避免点击冒泡触发行选中/跳转 */
  stopPropagation?: boolean;
}

/**
 * C-06 通用「打印」入口按钮。
 *
 * 真实失败路径：
 *   - 品牌接口失败 → 仍可打印（抬头降级为品牌名），但 toast.warning 告知；
 *   - 单据数据缺失（build 返回 null）→ 对话框内提示原因，打印按钮禁用；
 *   - 组装抛错 → toast.error + 对话框内提示。
 */
const PrintButton: React.FC<PrintButtonProps> = ({
  build,
  label = '打印',
  variant = 'outline',
  size = 'sm',
  disabled = false,
  className,
  stopPropagation = false,
}) => {
  const [open, setOpen] = useState(false);
  const [pack, setPack] = useState<PrintPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = useCallback(
    async (event?: React.MouseEvent<HTMLButtonElement>) => {
      if (stopPropagation) {
        event?.stopPropagation();
      }
      setOpen(true);
      setError(null);
      setPack(null);
      let brand: BrandConfig | null = null;
      try {
        brand = await getBrand();
      } catch (err) {
        // 品牌拿不到不能让打印直接失败：抬头降级为默认品牌名，但要如实提示
        toast.warning(getApiErrorMessage(err, '品牌信息读取失败，打印抬头将使用默认名称'));
      }
      try {
        const seed = build(brand);
        if (!seed) {
          setError('单据数据尚未加载完成，暂时无法生成打印件');
          return;
        }
        setPack(buildPrintPack(seed, brand));
      } catch (err) {
        const message = getApiErrorMessage(err, '生成打印数据失败');
        setError(message);
        toast.error(message);
      }
    },
    [build, stopPropagation],
  );

  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={disabled}
        className={className}
        onClick={(event) => void handleOpen(event)}
      >
        <Printer className="h-4 w-4" />
        {label}
      </Button>
      <PrintSettingsDialog open={open} onOpenChange={setOpen} pack={pack} error={error} />
    </>
  );
};

export default PrintButton;
