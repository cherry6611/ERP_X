import {
  AP_STATUS_LABELS,
  AR_STATUS_LABELS,
  ASSET_DISPOSAL_STATUS_LABELS,
  NOTE_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  RECEIPT_STATUS_LABELS,
  RETURN_ACTION_LABELS,
  RETURN_STATUS_LABELS,
} from './biz-labels';

/**
 * 状态标签表完整性规格（审计 §5.8 / B1 收尾）。
 *
 * ## 为什么这些断言值得存在
 *
 * 这份表是 `withDictionaryFallback('dict', {…})` 的**兜底**，而它同时被
 * 两处消费，缺键的后果不对称：
 *
 * 1. **显示**：`StatusBadge` 是 `labels[status] ?? status` —— 缺键显示英文码，
 *    虽然难看但还能看出是哪个状态；
 * 2. **筛选下拉**：`ArTab` / `ApTab` 的选项是
 *    `Object.entries(标签表).map(…)` 渲染的 —— **缺键意味着使用者根本
 *    无法筛出该状态**（下拉里没有那一项）。这是功能缺失，不是显示瑕疵。
 *
 * 本仓实际发生过：B1 给应收/应付加了作废路径，服务端写 `status='voided'`、
 * 契约也含 `'voided'`，但这两张表都没跟上。同批还发现
 * `ASSET_DISPOSAL_STATUS_LABELS` 的键**整套都是错的**（写的是审批流的
 * `draft/submitted/approved/completed/void`，契约里一个都没有），
 * 因为它当时**全仓 0 处引用** —— 没人用的表，键写错了也没人发现。
 *
 * `scripts/check-label-dict.mjs` 在 CI 里做同样的比对；本规格的价值是
 * **把具体文案也钉住**（门禁只查键的存在性，不查文案改没改），
 * 并让改动能在一个 `npm test` 里立刻暴露出影响面。
 */
describe('状态标签表：键集合与契约一致', () => {
  it('AR_STATUS_LABELS 含 voided（作废应收要能显示中文并可筛选）', () => {
    // 契约 ArStatus = 'open' | 'partial' | 'settled' | 'voided'
    expect(Object.keys(AR_STATUS_LABELS).sort()).toEqual([
      'open',
      'partial',
      'settled',
      'voided',
    ]);
    expect(AR_STATUS_LABELS.voided).toBe('已作废');
  });

  it('AP_STATUS_LABELS 含 approved 与 voided', () => {
    // 契约 ApStatus = 'pending' | 'approved' | 'partial' | 'paid' | 'voided'
    expect(Object.keys(AP_STATUS_LABELS).sort()).toEqual([
      'approved',
      'paid',
      'partial',
      'pending',
      'voided',
    ]);
    expect(AP_STATUS_LABELS.voided).toBe('已作废');
    // approved 原先也缺 —— 应付单审批通过后显示英文码
    expect(AP_STATUS_LABELS.approved).toBe('已批准');
  });

  it('RECEIPT_STATUS_LABELS 与 PAYMENT_STATUS_LABELS 都含 voided', () => {
    // 这两张表在更早的轮次已修过，此处防止回退
    expect(RECEIPT_STATUS_LABELS.voided).toBe('已作废');
    expect(PAYMENT_STATUS_LABELS.voided).toBe('已作废');
    expect(RECEIPT_STATUS_LABELS.partial).toBe('部分核销');
  });

  it('ASSET_DISPOSAL_STATUS_LABELS 的键**整套**对齐 AssetDisposalStatus', () => {
    /*
     * 回归防线：这张表原先写的是 `draft/submitted/approved/completed/void`
     * —— 那是**单据审批流**的键集合，与处置状态契约毫无交集。
     * 若有人把本地表又抄回来、或误用审批流的键，这条断言会红。
     */
    expect(Object.keys(ASSET_DISPOSAL_STATUS_LABELS).sort()).toEqual([
      'disposed',
      'disposing',
      'rejected',
      'scrapped',
    ]);
    // 审批流特有的键必须**不存在**
    for (const wrong of ['draft', 'submitted', 'approved', 'completed', 'void']) {
      expect(ASSET_DISPOSAL_STATUS_LABELS[wrong]).toBeUndefined();
    }
  });

  it('NOTE_STATUS_LABELS 的键整套对齐 NoteStatus', () => {
    // 契约 NoteStatus = received | held | endorsed | discounted | settled | dishonored
    expect(Object.keys(NOTE_STATUS_LABELS).sort()).toEqual([
      'discounted',
      'dishonored',
      'endorsed',
      'held',
      'received',
      'settled',
    ]);
    // 原先缺的三个
    expect(NOTE_STATUS_LABELS.received).toBe('已收到');
    expect(NOTE_STATUS_LABELS.held).toBe('持有中');
    expect(NOTE_STATUS_LABELS.dishonored).toBe('已拒付');
  });
});

describe('状态标签表：文案质量', () => {
  const ALL = {
    AR_STATUS_LABELS,
    AP_STATUS_LABELS,
    RECEIPT_STATUS_LABELS,
    PAYMENT_STATUS_LABELS,
    ASSET_DISPOSAL_STATUS_LABELS,
    NOTE_STATUS_LABELS,
  };

  it('每张表的每个值都是非空中文（不会渲染出空白或英文码）', () => {
    for (const [name, map] of Object.entries(ALL)) {
      for (const [key, label] of Object.entries(map)) {
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
        // 含中日韩统一表意文字 → 是中文文案而不是英文码
        expect(/[\u4e00-\u9fa5]/u.test(label)).toBe(true);
        // 反例防线：文案不能等于键本身（那等于没翻译）
        expect(label).not.toBe(key);
        expect(`${name}.${key}`).toBeTruthy();
      }
    }
  });

  it('「作废」类状态的文案统一为「已作废」', () => {
    /*
     * 统一文案是有意的：同一个语义在四个模块里出现，措辞不一致会让
     * "按字典改文案"变得不可预测，也让使用者以为是不同状态。
     */
    expect(AR_STATUS_LABELS.voided).toBe('已作废');
    expect(AP_STATUS_LABELS.voided).toBe('已作废');
    expect(RECEIPT_STATUS_LABELS.voided).toBe('已作废');
    expect(PAYMENT_STATUS_LABELS.voided).toBe('已作废');
  });

  it('AP_STATUS_LABELS 的 value 集合包含 ArStatus 没有的 paid（两侧不对称是有意的）', () => {
    /*
     * 登记一处**有意的不对称**：应付有 `paid`（已付清）而应收没有对应的
     * "已收清" —— 应收的终态是 `settled`（已结清，语义是核销完毕）。
     * 两者不是同一个词：应付按"付款"、应收按"核销"。若有人为统一而
     * 把 `settled` 改成 `paid`，这条断言会红。
     */
    expect(Object.keys(AP_STATUS_LABELS)).toContain('paid');
    expect(Object.keys(AR_STATUS_LABELS)).not.toContain('paid');
    expect(Object.keys(AR_STATUS_LABELS)).toContain('settled');
    expect(Object.keys(AP_STATUS_LABELS)).not.toContain('settled');
  });
});


describe('RETURN_ACTION_LABELS（退货动作文案）', () => {
  it('覆盖全部 5 个动作，且都是非空中文', () => {
    /*
     * 这张表是本轮修「提示与按钮相反」时新增的。
     *
     * 原先 `ReturnsPage` 用**状态**标签充当**动作**提示：
     * 草稿行点「提交」提示「草稿成功」、待审批行点「批准」提示「待审批成功」——
     * 提示说的是动作发生**前**的状态，与刚点的按钮矛盾。
     *
     * 键集合必须与 `ReturnAction` 联合类型完全一致：类型是
     * `Record<ReturnAction, string>`，所以**漏键或多键都会编译失败**，
     * 这里再断言一次文案质量（非空、中文、不等于键本身）。
     */
    expect(Object.keys(RETURN_ACTION_LABELS).sort()).toEqual([
      'approve',
      'complete',
      'reject',
      'submit',
      'void',
    ]);
    for (const [action, label] of Object.entries(RETURN_ACTION_LABELS)) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(/[\u4e00-\u9fa5]/u.test(label)).toBe(true);
      // 反例防线：文案不能等于键本身（那等于没翻译）
      expect(label).not.toBe(action);
    }
  });

  it('动作文案与**状态**文案不重合（否则又会退化成"状态当动作"）', () => {
    /*
     * 这条是本次修复的核心防线：如果某个动作的文案恰好等于某个状态文案，
     * 那么"把状态标签传给动作提示"这个错误就无法通过文案被发现。
     * 实测两者无交集 —— 若将来有人把 `submit` 写成 '草稿'，这条会红。
     */
    const actionLabels = new Set(Object.values(RETURN_ACTION_LABELS));
    const statusLabels = new Set(Object.values(RETURN_STATUS_LABELS));
    for (const label of actionLabels) {
      expect(statusLabels.has(label)).toBe(false);
    }
  });

  it('与服务端状态机的文案保持一致（服务端是动作的权威）', () => {
    /*
     * 客户端不 import 服务端模块（不该依赖 server 目录），因此这里**只断言
     * 键集合与关键文案**，并与 `server/common/tax/return-rules.ts` 的
     * `RETURN_ACTION_LABELS` 人工核对过：
     *   submit 提交审批 / approve 批准 / reject 驳回 /
     *   complete 完成退货（红字凭证）/ void 作废
     *
     * 客户端把 `complete` 简写为「完成退货」而不是服务端的
     * 「完成退货（红字凭证）」—— 因为客户端这条文案会拼成提示
     * 「完成退货成功」，带上括号注解读起来不通顺；语义未变。
     * 这条差异是**有意**的，写在这里以免下次被当成不一致"修掉"。
     */
    expect(RETURN_ACTION_LABELS.submit).toBe('提交审批');
    expect(RETURN_ACTION_LABELS.approve).toBe('批准');
    expect(RETURN_ACTION_LABELS.reject).toBe('驳回');
    expect(RETURN_ACTION_LABELS.void).toBe('作废');
    expect(RETURN_ACTION_LABELS.complete).toBe('完成退货');
  });
});
