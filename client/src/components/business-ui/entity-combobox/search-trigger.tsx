'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CircleX, X } from 'lucide-react';

import { useEntityComboboxContext } from '@client/src/components/business-ui/entity-combobox/context';
import {
  searchTagVariants,
  searchTriggerVariants,
  tagCloseIconVariants,
  type ComboboxSize,
} from '@client/src/components/business-ui/entity-combobox/size-variants';
import type {
  ClassNamesConfig,
  ItemValue,
} from '@client/src/components/business-ui/entity-combobox/types';
import { cn } from '@/lib/utils';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';

export type SearchTriggerProps = {
  size?: ComboboxSize;
  placeholder?: string;
  maxTagCount?: number | 'responsive';
  maxTagTextLength?: number;
  tagClosable?: boolean;
  classNames?: ClassNamesConfig;
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
  /**
   * 自定义渲染单个标签
   * @param value 标签的值对象
   * @param onClose 关闭标签的回调
   * @param disabled 是否禁用
   * @returns ReactNode
   */
  renderTag?: (
    value: ItemValue,
    onClose: (value: ItemValue, e: React.MouseEvent) => void,
    disabled?: boolean,
  ) => React.ReactNode;
  /**
   * 判断选项是否禁用
   */
  getOptionDisabled?: (value: ItemValue) => boolean;
  ref?: React.Ref<HTMLDivElement>;
};

export const SearchTrigger = ({
  size = 'medium',
  placeholder = '请选择',
  maxTagCount,
  maxTagTextLength,
  tagClosable = true,
  classNames,
  onFocus,
  onBlur,
  renderTag,
  getOptionDisabled,
  ref,
}: SearchTriggerProps) => {
  const {
    selectedValue,
    multiple,
    handleDeselect,
    handleClear,
    open,
    disabled,
  } = useEntityComboboxContext();

  const selectedArray = Array.isArray(selectedValue) ? selectedValue : [];
  const measureRef = useRef<HTMLDivElement>(null);
  const [responsiveCount, setResponsiveCount] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (maxTagCount !== 'responsive' || !multiple) {
      setResponsiveCount(null);
      return;
    }
    const el = measureRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      // 估算：每标签约 88px，预留 +N 与清除按钮
      const approx = Math.max(1, Math.floor((width - 72) / 88));
      setResponsiveCount(Math.min(approx, selectedArray.length));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxTagCount, multiple, selectedArray.length]);

  const effectiveMax =
    typeof maxTagCount === 'number'
      ? maxTagCount
      : maxTagCount === 'responsive'
        ? (responsiveCount ?? selectedArray.length)
        : selectedArray.length;

  const displayTags =
    multiple && (typeof maxTagCount === 'number' || maxTagCount === 'responsive')
      ? selectedArray.slice(0, effectiveMax)
      : multiple
        ? selectedArray
        : [];
  const hiddenCount =
    multiple && (typeof maxTagCount === 'number' || maxTagCount === 'responsive')
      ? Math.max(0, selectedArray.length - effectiveMax)
      : 0;
  const hiddenTags =
    multiple && (typeof maxTagCount === 'number' || maxTagCount === 'responsive')
      ? selectedArray.slice(effectiveMax)
      : [];

  const handleTagClose = (value: ItemValue, e: React.MouseEvent) => {
    e.stopPropagation();
    if (getOptionDisabled?.(value)) return;
    if (!multiple) {
      handleClear(); // 单选模式清空
    } else {
      handleDeselect(value); // 多选模式删除指定项
    }
  };

  const truncateText = (text: string) => {
    if (!maxTagTextLength || text.length <= maxTagTextLength) {
      return text;
    }
    return text.slice(0, maxTagTextLength) + '...';
  };

  // 单选模式下显示选中值
  const displayValue =
    !multiple && selectedValue && !Array.isArray(selectedValue)
      ? selectedValue.name
      : '';

  return (
    <div
      ref={ref}
      tabIndex={disabled ? -1 : 0}
      role="combobox"
      aria-expanded={open}
      aria-controls="combobox-content"
      aria-disabled={disabled}
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'group',
        searchTriggerVariants({ size }),
        disabled && 'cursor-not-allowed bg-muted hover:border-input',
        classNames?.trigger,
      )}
      onFocus={disabled ? undefined : onFocus}
      onBlur={disabled ? undefined : onBlur}
    >
      <div ref={measureRef} className="flex min-w-0 flex-1 items-center gap-1">
        {!multiple && displayValue ? (
          renderTag ? (
            renderTag(
              selectedValue as ItemValue,
              handleTagClose,
              getOptionDisabled?.(selectedValue as ItemValue),
            )
          ) : (
            <span className="truncate">{displayValue}</span>
          )
        ) : multiple && selectedArray.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {displayTags.map((value) =>
              renderTag ? (
                renderTag(value, handleTagClose, getOptionDisabled?.(value))
              ) : (
                <Badge
                  key={value.id}
                  variant="secondary"
                  className={cn(searchTagVariants({ size }), classNames?.tag)}
                >
                  <span>{truncateText(value.name)}</span>
                  {tagClosable && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-1 size-auto rounded-sm p-0 opacity-70 ring-offset-background transition-opacity hover:opacity-100"
                      onClick={(e) => handleTagClose(value, e)}
                    >
                      <X className={tagCloseIconVariants({ size })} />
                    </Button>
                  )}
                </Badge>
              ),
            )}
            {hiddenCount > 0 && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className={cn(
                      searchTagVariants({ size }),
                      'cursor-pointer',
                    )}
                  >
                    +{hiddenCount}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="w-auto max-w-80 p-2" align="start">
                  <div className="flex flex-wrap gap-1">
                    {hiddenTags.map((value) =>
                      renderTag ? (
                        renderTag(
                          value,
                          handleTagClose,
                          getOptionDisabled?.(value),
                        )
                      ) : (
                        <Badge
                          key={value.id}
                          variant="secondary"
                          className={cn(
                            searchTagVariants({ size }),
                            classNames?.tag,
                          )}
                        >
                          <span>{truncateText(value.name)}</span>
                          {tagClosable && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="ml-1 size-auto rounded-sm p-0 opacity-70 ring-offset-background transition-opacity hover:opacity-100"
                              onClick={(e) => handleTagClose(value, e)}
                            >
                              <X className={tagCloseIconVariants({ size })} />
                            </Button>
                          )}
                        </Badge>
                      ),
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
      </div>

      {selectedArray.length > 0 && (
        <Button
          variant="ghost"
          size="icon"
          data-slot="combobox-clear"
          disabled={disabled}
          aria-disabled={disabled}
          className={cn(
            'flex h-4 w-4 items-center rounded-full text-muted-foreground opacity-0 group-hover:opacity-100 not-disabled:hover:bg-transparent not-disabled:hover:text-primary aria-disabled:opacity-0',
            classNames?.clear,
          )}
          onClick={(e) => {
            e.stopPropagation();
            handleClear();
          }}
        >
          <>
            <CircleX className="h-3! w-3!" />
            <span className="sr-only">Clear all</span>
          </>
        </Button>
      )}

      <div className={cn('ml-1', classNames?.suffix)}>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 opacity-50" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        )}
      </div>
    </div>
  );
};
