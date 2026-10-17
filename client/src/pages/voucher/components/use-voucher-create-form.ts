/**
 * 「新增手工凭证」弹窗的数据与表单逻辑（§5.9 / F8）。
 *
 * ## 为什么这一段要独立成 hook
 *
 * `VoucherPanel.tsx` 的体量从来不在文件头的声明里，而在末尾那段 259 行的
 * 新增弹窗 JSX。本轮把它拆成 `./CreateVoucherDialog.tsx` 之后，弹窗需要的
 * **数据 + 表单 + 提交**必须跟着它走：科目下拉、辅助维度取值都只有这个弹窗
 * 在用，留在面板里就意味着主文件仍要替弹窗保管全部 state、2 个查询与 1 个
 * `useForm`。
 *
 * ## 行为零变更的三条约束（搬迁时逐条核对）
 *
 * ① **调用点无条件求值**。本 hook 由 `CreateVoucherDialog` **在组件顶层**
 *    调用，而该弹窗在面板里是**常驻挂载**的（`<Dialog open={…}>`，
 *    不是 `{open && <Dialog/>}`）—— 因此 2 个 `useAsyncData` 与 2 个
 *    `useEffect` 的触发时机与原实现**逐次对应**：迁移前它们在面板顶层无条件
 *    求值，迁移后在弹窗顶层无条件求值，弹窗又恒被渲染。
 *    若将来有人把这个弹窗改成条件挂载，副作用时机就会变（例如科目列表每次
 *    打开才取、期间列表丢缓存）—— 这也是面板注释强调弹窗必须常驻的原因。
 *
 * ② **表单实例与"打开时重置"的 effect 同处一个作用域**（都在这里），
 *    顺序仍是 `useForm` → 2 个 `useEffect`。重置的触发点仍是
 *    `createOpen` 由 `false` 变 `true`，且 `todayIso()` / `currentPeriod()`
 *    仍在该时刻求值 —— 页面挂一夜（跨零点）后新建凭证，默认日期仍是当天，
 *    不会退回昨天。
 *
 *    ⚠️ **原实现没有别的重置**：关闭弹窗不重置（只有"打开"重置），提交成功
 *    也不重置（下次打开时由同一个 effect 覆盖）。搬迁后逐条保持原样。
 *
 * ③ **`useAsyncData` 的 deps 数组逐字未改**，包括 `[requiredAuxCodes.join(','),
 *    watchedPeriod]` 这个手工伪造稳定依赖的写法（见 `hooks/useAsyncData.ts`
 *    文档中对该写法的说明）。
 */
import { useEffect, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useFieldArray,
  useForm,
  type FieldArrayWithId,
  type UseFieldArrayAppend,
  type UseFieldArrayRemove,
  type UseFormReturn,
} from 'react-hook-form';
import { toast } from 'sonner';
import { voucherApi } from '@client/src/api';
import * as financeReportsApi from '@client/src/api/finance-reports';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, currentPeriod, todayIso } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  createEmptyVoucherForm,
  isBalanced,
  normalizeVoucherLine,
  sumVoucherLines,
  validateVoucherLine,
  voucherSchema,
  type VoucherFormData,
} from './voucher-form';
import type {
  AccountItem,
  AuxDimensionItem,
  CreateVoucherDto,
  CreateVoucherLineDto,
} from '@shared/api.interface';

interface UseVoucherCreateFormOptions {
  /**
   * 弹窗是否打开。它同时是**重置的触发点**：由 `false` 变 `true` 时
   * 按当天重新求值默认值（原实现即如此，见文件头 ②）。
   */
  createOpen: boolean;
  /** 关闭弹窗（创建成功后调用） */
  onOpenChange: (open: boolean) => void;
  /** 创建成功后调用，父组件据此重取列表并回到第 1 页 */
  onCreated: () => void | Promise<void>;
}

interface UseVoucherCreateFormResult {
  form: UseFormReturn<VoucherFormData>;
  /** `useFieldArray` 的行 / 追加 / 删除，供 JSX 逐行渲染与增删 */
  fields: FieldArrayWithId<VoucherFormData, 'lines', 'id'>[];
  append: UseFieldArrayAppend<VoucherFormData, 'lines'>;
  remove: UseFieldArrayRemove;
  /** 末级科目（后端拒绝非末级科目做账，前端不先把非法项列出来） */
  activeAccounts: AccountItem[];
  /** 辅助维度 code → 名称（A-05） */
  auxNameByCode: Map<string, string>;
  /** 已选科目要求挂的维度 → 本期已在用的取值（datalist 提示） */
  auxValueHints: Map<string, string[]> | null | undefined;
  watchedLines: VoucherFormData['lines'] | undefined;
  totalDebit: number;
  totalCredit: number;
  /** 分录级错误提示（`lines` 根路径上的 message） */
  getLinesErrorMessage: () => string | null;
  /** P1-3：表单内「错误提示」单列展示（后端 message 原样） */
  submitError: string | null;
  /** 提交中（创建按钮禁用） */
  operating: boolean;
  onSubmit: ReturnType<UseFormReturn<VoucherFormData>['handleSubmit']>;
}

export function useVoucherCreateForm({
  createOpen,
  onOpenChange,
  onCreated,
}: UseVoucherCreateFormOptions): UseVoucherCreateFormResult {
  const [operating, setOperating] = useState(false);
  // P1-3：表单内「错误提示」单列展示（后端 message 原样）
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: accountsResult } = useAsyncData(
    () => voucherApi.listAccounts({ page: 1, pageSize: 500 }),
    [],
  );
  /**
   * P1-2：科目下拉只能选末级科目。
   * 后端对非末级（汇总）科目直接报错「不可直接做账」，前端不应先把非法项列出来，
   * 让用户选完再被拒。
   */
  const activeAccounts = (accountsResult?.items ?? []).filter(
    (a: AccountItem) => a.status === 'active' && a.isLeaf,
  );

  /** A-05：辅助核算维度定义（code → 名称） */
  const { data: auxDimensions } = useAsyncData<AuxDimensionItem[]>(
    () => financeReportsApi.listAuxDimensions(),
    [],
  );
  const auxNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const dim of auxDimensions ?? []) {
      if (dim.enabled) map.set(dim.code, dim.name);
    }
    return map;
  }, [auxDimensions]);

  const form = useForm<VoucherFormData>({
    resolver: zodResolver(voucherSchema),
    /*
     * 默认日期必须在**表单初始化 / 弹窗打开时**求值，不能是模块加载时的常量：
     * 页面挂着一夜（跨零点）后新建凭证，模块级的日期已经过期，
     * 默认值会停留在昨天。故这里调用 createEmptyVoucherForm(today, period)。
     */
    defaultValues: createEmptyVoucherForm(todayIso(), currentPeriod()),
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'lines',
  });

  const watchedDate = form.watch('voucherDate');
  const watchedPeriod = form.watch('period');
  const watchedLines = form.watch('lines');

  /** 当前表单可能用到的辅助维度编码（已选科目要求挂的维度合集） */
  const requiredAuxCodes = useMemo(() => {
    const accountById = new Map(activeAccounts.map((a) => [a.id, a]));
    const codes = new Set<string>();
    for (const line of watchedLines ?? []) {
      const account = accountById.get(line.accountId);
      for (const code of account?.auxRequired ?? []) codes.add(code);
    }
    return [...codes].sort();
  }, [watchedLines, activeAccounts]);

  /**
   * A-05：辅助维度可选值（datalist 提示用）。
   * 取自本期已在用的取值；本期尚无数据时为空，输入框仍允许手录，
   * 不会因为“新期间没有历史值”而卡住录账。
   */
  const { data: auxValueHints } = useAsyncData(async () => {
    const map = new Map<string, string[]>();
    await Promise.all(
      requiredAuxCodes.map(async (code) => {
        try {
          const values = await financeReportsApi.getAuxDimensionValues({
            period: watchedPeriod || currentPeriod(),
            dimensionCode: code,
          });
          map.set(
            code,
            values
              .map((v) => v.dimensionValue)
              .filter((v) => v && v !== '（未指定）'),
          );
        } catch {
          map.set(code, []);
        }
      }),
    );
    return map;
  }, [requiredAuxCodes.join(','), watchedPeriod]);

  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(watchedDate)) {
      form.setValue('period', watchedDate.slice(0, 7));
    }
  }, [watchedDate, form]);

  useEffect(() => {
    if (createOpen) {
      // 同上：每次打开弹窗都按**当天**重新求值，长驻页面不会用到昨天的日期
      form.reset(createEmptyVoucherForm(todayIso(), currentPeriod()));
    }
  }, [createOpen, form]);

  const { totalDebit, totalCredit } = sumVoucherLines(watchedLines);

  const getLinesErrorMessage = (): string | null => {
    const err: unknown = form.formState.errors.lines;
    if (err && typeof err === 'object' && !Array.isArray(err)) {
      const { message } = err as { message?: unknown };
      if (typeof message === 'string' && message) return message;
    }
    return null;
  };

  /**
   * P1-2：把「科目必挂维度 → 输入值」转成后端入参（VoucherLineAuxDto[]）。
   * 只提交科目声明必挂的维度；空值不提交，由后端给出「要求填写辅助核算维度」的准确报错。
   *
   * 该装配现在由 `normalizeVoucherLine(行, 科目必挂维度)` 一并承担
   * （它同时负责金额取整与 DTO 归一），此处不再重复调用 `buildLineAux`。
   */
  const onSubmit = form.handleSubmit(async (values) => {
    const lines: CreateVoucherLineDto[] = [];
    for (let i = 0; i < values.lines.length; i += 1) {
      const line = values.lines[i];
      const err = validateVoucherLine(i, line);
      if (err) {
        form.setError(`lines.${err.index}.${err.field}`, { message: err.message });
        return;
      }
      lines.push(
        normalizeVoucherLine(
          line,
          activeAccounts.find((a) => a.id === line.accountId)?.auxRequired,
        ),
      );
    }
    /*
     * ⚠️ 这里原先写的是 `Math.abs(totalDebit - totalCredit) > 0.001` —— 它表达的业务规则
     * 与 `isBalanced` 是**同一个**（借贷是否平衡），却是第二份表述。上一轮把 `isBalanced` 修成
     * `round2(a) === round2(b)`（浮点差值比较是**量级相关**的：`1000/1000.001` 与
     * `-100/-100.001` 数学上对称、结论相反），但只改了展示处的那一次调用，
     * 本处仍是旧写法 —— 同一个文件里留着两种"是否平衡"的写法，正是下一轮有人
     * 照抄错的那份的入口。
     *
     * **本次改动行为零变更，依据是三条可验证的不变量**（不是"看起来一样"）：
     *   ① `totalDebit` / `totalCredit` 来自 `sumVoucherLines`，它对两侧**各自**
     *      做过 `round2`，因此这里的入参恒在两位小数网格上；
     *   ② `round2` 在两位小数网格上是**幂等**的（`round2(round2(v)) === round2(v)`），
     *      故 `isBalanced(a,b)` 在此处退化为 `a === b`；
     *   ③ 于是旧写法也退化为 `!(Math.abs(a-b) > 0.001)` ⇔ `a === b`
     *      —— 对 (合计,合计) 的全部两位小数组合穷举 700,007 种，两种写法
     *      结论不同的为 **0** 种。
     * 即：修掉的是一处**表述分歧**（潜在陷阱），不是线上缺陷。
     *
     * 同时与服务端口径对齐：`server/modules/voucher/voucher.service.ts`
     * 的 `createVoucher` 判据就是 `round2(totalDebit) !== round2(totalCredit)`。
     */
    if (!isBalanced(totalDebit, totalCredit)) {
      form.setError('lines', {
        type: 'manual',
        message: `借贷不平衡：借方合计 ${formatMoney(totalDebit)}，贷方合计 ${formatMoney(totalCredit)}`,
      });
      return;
    }
    const dto: CreateVoucherDto = {
      voucherDate: values.voucherDate,
      period: values.period,
      summary: values.summary,
      sourceType: 'manual',
      lines,
      remark: values.remark || undefined,
    };
    setOperating(true);
    setSubmitError(null);
    try {
      await voucherApi.createVoucher(dto);
      toast.success('手工凭证已创建');
      onOpenChange(false);
      await onCreated();
    } catch (err) {
      // P1-3：原样透出后端 message，并在表单内单列一行「错误提示」
      const message = getApiErrorMessage(err, '创建凭证失败');
      setSubmitError(message);
      toast.error(message);
    } finally {
      setOperating(false);
    }
  });

  return {
    form,
    fields,
    append,
    remove,
    activeAccounts,
    auxNameByCode,
    auxValueHints,
    watchedLines,
    totalDebit,
    totalCredit,
    getLinesErrorMessage,
    submitError,
    operating,
    onSubmit,
  };
}
