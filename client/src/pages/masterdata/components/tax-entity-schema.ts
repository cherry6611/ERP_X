/**
 * §5.9 拆分：纳税主体的**表单模型**从 `TaxEntities.tsx` 抽出。
 *
 * ## 为什么税率白名单必须能单测
 *
 * `superRefine` 里那条「销项/进项税率必须落在该纳税人类型的允许档位内」是
 * **监管口径**，不是界面偏好：一般纳税人与小规模的可选税率档位不同
 * （`ALLOWED_RATES`，权威定义在 `shared/tax.ts`）。
 *
 * 写成内联校验有三个后果，都属于"界面上看不出来"：
 *   ① 档位表若被改错（例如把 `general` 的可选值放宽到含 1%），
 *      界面上一切正常，直到税务申报时才暴露；
 *   ② `superRefine` 里若漏了 `defaultInputRate` 那一支，进项税率可以随便填；
 *   ③ 报错信息里若不带字段路径（`path`），错误会挂在整表上而不是具体输入框旁。
 *
 * 这三条都能用断言直接钉住，所以这段逻辑不该留在组件里。
 */

import { z } from 'zod';
import { ALLOWED_RATES, type TaxpayerType } from '@shared/tax';

/**
 * 新建纳税主体的表单空值。
 *
 * ⚠️ 每个字段都必须是**具体初值**而不是 `undefined`（受控组件警告），
 * 且 `citSmallMicro` 的三态语义是 `true / false / null`：
 * `null` = **未确认**，业务上按"不享受小微优惠"处理（偏严）。
 * 不要把它简化成 `false` —— 那会丢掉"没确认过"这个信息。
 */
export const EMPTY_TAX_ENTITY_FORM = {
  code: '',
  name: '',
  uscc: '',
  taxpayerType: 'general' as TaxpayerType,
  defaultOutputRate: 6,
  defaultInputRate: 6,
  /* T9：申报周期（小规模免征额度判定的必要要件）；'' = 未声明 */
  vatFilingCycle: '' as '' | 'monthly' | 'quarterly',
  /* T9：城建税率（百分数）；'' = 未配置 —— 未配置时附加税计提会拒绝出数 */
  urbanMaintRate: '',
  vatExemptionEnabled: true,
  /* §4.7(e)：企业所得税小微资格；null = 未确认（按不享受处理，偏严） */
  citSmallMicro: null as boolean | null,
  invoiceTitle: '',
  invoiceAddress: '',
  invoicePhone: '',
  invoiceBank: '',
  invoiceAccount: '',
  remark: '',
};

/**
 * 纳税主体表单校验。
 *
 * 关注点分离：本 schema 只管**表单里会出现的字段**（`code/name/taxpayerType/两个默认税率`）。
 * 其余字段（申报周期、城建税率、发票抬头等）不在表单校验范围内 ——
 * 它们的规则在 `./tax-entity-form` 的 payload 构造函数里（那里才有 `parseUrbanMaintRate`）。
 */
export const taxEntitySchema = z
  .object({
    code: z.string().trim().min(1, '编码不能为空'),
    name: z.string().trim().min(1, '名称不能为空'),
    taxpayerType: z.enum(['general', 'small'], {
      message: '请选择纳税人类型',
    }),
    defaultOutputRate: z.number({
      message: '请选择默认销项税率',
    }),
    defaultInputRate: z.number({
      message: '请选择默认进项税率',
    }),
  })
  .superRefine((data, ctx) => {
    const allowed = ALLOWED_RATES[data.taxpayerType] as readonly number[];
    if (!allowed.includes(data.defaultOutputRate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultOutputRate'],
        message: '销项税率不在允许范围内',
      });
    }
    if (!allowed.includes(data.defaultInputRate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultInputRate'],
        message: '进项税率不在允许范围内',
      });
    }
  });
