import {
  arSettleStatus,
  isVoucherBalanced,
  openAmount,
  receiptMatchStatus,
} from './ar-match';

describe('ar-match helpers', () => {
  it('openAmount 计算未核销余额', () => {
    expect(openAmount(1000, 300)).toBe(700);
    expect(openAmount(100, 100)).toBe(0);
  });

  it('arSettleStatus / receiptMatchStatus 按阈值切换状态', () => {
    expect(arSettleStatus(500, 1000)).toBe('partial');
    expect(arSettleStatus(1000, 1000)).toBe('settled');
    expect(receiptMatchStatus(200, 500)).toBe('partial');
    expect(receiptMatchStatus(500, 500)).toBe('matched');
  });

  it('isVoucherBalanced 分比较借贷', () => {
    expect(
      isVoucherBalanced([
        { debit: 106 },
        { credit: 100 },
        { credit: 6 },
      ])
    ).toBe(true);
    expect(
      isVoucherBalanced([{ debit: 100 }, { credit: 99.99 }])
    ).toBe(false);
  });

  it('全额核销后回款状态必为 matched —— 「登记回款」直接核销依赖这条不变量', () => {
    /*
     * ## 这条断言守的是什么
     *
     * 「登记回款」现在可以直接指定应收单并**在同一事务内**核销
     * （`CreateReceiptDto.arId` → `ArService.applyWriteoffInTx`）。
     *
     * `applyWriteoffInTx` 用 `receiptMatchStatus(newUsed, receipt.amount)`
     * 写回款状态；而 `createReceipt` 在同一事务内用的是 INSERT 时的行快照
     * （`status` 仍是 `unmatched`），所以它必须**另算一次**要返回给前端的
     * 状态 —— 否则调用方会拿到"已核销但状态显示未核销"的旧值。
     *
     * `createReceipt` 的写法是 `receiptMatchStatus(dto.amount, dto.amount)`
     * （该入口不做部分核销：核销金额恒等于回款金额）。这条断言钉住
     * "全额核销 ⇒ matched"对所有正金额都成立，因此那一行与
     * `applyWriteoffInTx` 实际写入的状态**必然一致**，不会出现两者分叉。
     *
     * 若有人把 `receiptMatchStatus` 的判据改成 `>` 或加别的分支，
     * 这条会先红 —— 而不是等到线上出现"回款显示未核销"才被发现。
     */
    for (const amount of [0.01, 1, 100, 348.5, 12345.67]) {
      expect(receiptMatchStatus(amount, amount)).toBe('matched');
    }
    // 部分核销才应是 partial（对照，说明上面不是"恒返回 matched"）
    expect(receiptMatchStatus(50, 100)).toBe('partial');
  });
});
