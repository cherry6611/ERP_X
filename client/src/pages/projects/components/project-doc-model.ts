/**
 * 项目文档区块（`ProjectDocSection`）的**零 React 依赖**声明（§5.9 / F8）。
 *
 * 从 `ProjectDocSection.tsx` 原样搬来的四块，逐字未改，只是换了个文件：
 *   · `DOC_TYPES` / `DocTypeValue` / `DOC_TYPE_VALUES` / `getDocType`
 *     —— 文档类型枚举与查表；
 *   · `SYNC_STATUS_BADGES` —— 云空间同步状态 → 徽标文案 / variant；
 *   · `parseDocTypeLabel` —— **从标题前缀解析文档类型**；
 *   · `docFormSchema` / `DocFormData` —— 新增文档表单的校验规则。
 *
 * ## 为什么这一块搬出来收益最大
 *
 * 它们是"改错了界面上看不出来"的重灾区，且**不需要渲染就能断言**：
 *   · `parseDocTypeLabel` 是**文档类型的解析口径** —— 附件模型没有类型字段，
 *     类型完全承载在标题前缀 `[类型] 文档名` 上（见 `AGENTS.md`「项目详情页工作台」
 *     一条）。正则少一个 `^`、`[^\]]+` 写成 `.+` 都会让带方括号的文件名解析出
 *     错误的类型标签，而界面上只会显示成「未标记」，看不出是解析坏了；
 *   · `DOC_TYPES` 的 `value` 是 `docFormSchema` 的枚举值域，`label` 是写进标题
 *     前缀的那段文字 —— 两者必须同时对上 `parseDocTypeLabel` 的返回值
 *     （列表渲染里的 `DOC_TYPES.find((t) => t.label === typeLabel)` 就是靠
 *     `label` 这一列对上前缀的；此处**没有**把它抽成具名函数，因为那是拆分
 *     之外的行为改动面）。
 *
 * ## `parseDocTypeLabel` 的解析语义（**逐字保留，未做任何"改进"**）
 *
 * 原实现写作 `/^\[([^\]]+)\]/.exec(fileName)`，返回**第一个**方括号组。这里
 * 逐字照抄，包括它刻意宽松的地方：
 *   · `exec` 只看**开头**（`^`），所以 `[需求书] 需求说明书` → `需求书`，
 *     而 `需求说明书 [需求书]` → `null`（不解析中间/结尾的方括号）—— 这是有意的：
 *     只有本页面自己写入的前缀才可信，用户文件名里自带的方括号不该被当成类型；
 *   · `[^\]]+` 要求方括号内**非空**，所以 `[] 空标题` → `null`；
 *   · `+` 是**贪婪**的，`[a]b]c` 会取到 `a`（遇到第一个 `]` 就停，因为 `[^\]]`
 *     本身就排除了 `]`）。
 * ⚠️ 不要"顺手"把它改成 `split(']')` 或 `slice` —— 那会改变 `[a]b]c` 这类
 * 输入的结果，而这类输入在历史数据里是存在的（上传文件名自带方括号）。
 *
 * ## 标题前缀的**另一个**消费点（不在本文件，改动时一并核对）
 *
 * 列表展示标题时会**去掉**这段前缀：`fileName.indexOf(']') + 1` 再 `trim()`
 * （见 `./ProjectDocList`）。它用的是 `indexOf` 而非上面的正则，两者对
 * "前缀只有 `[` 没有 `]`"这类畸形输入的判定**不一致** —— 原实现就如此，
 * 本次拆分未动，故此处只做标注、不做统一。
 */
import { z } from 'zod';

/** 文档类型枚举：附件模型无类型字段，以标题前缀「[类型] 名称」承载 */
export const DOC_TYPES = [
  { value: 'requirement', label: '需求书', variant: 'info' },
  { value: 'plan', label: '执行计划', variant: 'warning' },
  { value: 'solution', label: '方案文档', variant: 'secondary' },
  { value: 'acceptance', label: '验收报告', variant: 'success' },
  { value: 'other', label: '其他', variant: 'outline' },
] as const;

export type DocTypeValue = (typeof DOC_TYPES)[number]['value'];

export const DOC_TYPE_VALUES = DOC_TYPES.map((t) => t.value) as [
  DocTypeValue,
  ...DocTypeValue[],
];

export const getDocType = (value: string): (typeof DOC_TYPES)[number] | undefined =>
  DOC_TYPES.find((t) => t.value === value);

export const SYNC_STATUS_BADGES: Record<
  string,
  { label: string; variant: 'secondary' | 'success' | 'info' | 'destructive' }
> = {
  pending: { label: '待同步', variant: 'secondary' },
  synced: { label: '已同步', variant: 'success' },
  skipped: { label: '已跳过', variant: 'info' },
  failed: { label: '失败', variant: 'destructive' },
};

/** 从标题前缀解析文档类型，如「[需求书] 需求说明书」 */
export const parseDocTypeLabel = (fileName: string): string | null => {
  const match = /^\[([^\]]+)\]/.exec(fileName);
  return match ? match[1] : null;
};

export const docFormSchema = z
  .object({
    docType: z.enum(DOC_TYPE_VALUES, { message: '请选择文档类型' }),
    mode: z.enum(['upload', 'link']),
    docTitle: z.string(),
    docUrl: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.mode !== 'link') return;
    if (!data.docTitle.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docTitle'],
        message: '请输入文档标题',
      });
    }
    if (!data.docUrl.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docUrl'],
        message: '请输入飞书云文档链接',
      });
    } else if (!/^https?:\/\//.test(data.docUrl.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docUrl'],
        message: '请输入有效的文档链接（http/https）',
      });
    }
  });

export type DocFormData = z.infer<typeof docFormSchema>;
