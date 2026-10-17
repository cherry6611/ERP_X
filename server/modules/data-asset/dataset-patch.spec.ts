import { buildDatasetUpdatePlan } from './dataset-patch';

/**
 * 数据集 PATCH 三态语义的回归测试。
 *
 * 这组测试守的是"客户端发得过去、服务端静默丢弃"这类缺陷中**最隐蔽**的一支：
 * 契约里补了字段、service 却用真值判断（或干脆没 patch），于是
 * 「清空」与「不动」被混为一谈 —— 界面提示"已更新"，库里旧值还在。
 *
 * 因此下面把 `undefined` / `null` / 值三种输入**逐一穷举**，
 * 并且对 `contractId` 额外断言"键是否存在"，而不只是断言"值是什么"。
 */
describe('buildDatasetUpdatePlan：PATCH 字段归并判据', () => {
  describe('contractId 三态', () => {
    const CONTRACT_A = '11111111-1111-4111-8111-111111111111';
    const CONTRACT_B = '22222222-2222-4222-8222-222222222222';

    it('传 UUID → 写入该 id，并要求调用方校验合同存在', () => {
      const plan = buildDatasetUpdatePlan({ contractId: CONTRACT_A });
      expect(plan.patch.contractId).toBe(CONTRACT_A);
      expect(plan.contractIdToValidate).toBe(CONTRACT_A);
    });

    it('传 null → 写入 null（解除关联），且**不需要**存在性校验', () => {
      const plan = buildDatasetUpdatePlan({ contractId: null });
      // 必须"有键且值为 null"，否则等于没清除
      expect(Object.prototype.hasOwnProperty.call(plan.patch, 'contractId')).toBe(
        true
      );
      expect(plan.patch.contractId).toBeNull();
      // null 没有东西要校验；若这里返回了值，service 会去查一个不存在的合同
      expect(plan.contractIdToValidate).toBeNull();
    });

    it('不传（undefined）→ patch 里**没有**该键，即保持原值不动', () => {
      const plan = buildDatasetUpdatePlan({ name: '仅改名字' });
      expect(
        Object.prototype.hasOwnProperty.call(plan.patch, 'contractId')
      ).toBe(false);
      expect(plan.contractIdToValidate).toBeNull();
    });

    it('三态互不相同（防止真值判断把 null 与 undefined 合并）', () => {
      const set = buildDatasetUpdatePlan({ contractId: CONTRACT_B });
      const clear = buildDatasetUpdatePlan({ contractId: null });
      const skip = buildDatasetUpdatePlan({});
      // 写入 vs 清除
      expect(set.patch.contractId).not.toBe(clear.patch.contractId);
      // 清除 vs 不动：一个"有键且为 null"，一个"没有键"
      expect(Object.keys(clear.patch)).toContain('contractId');
      expect(Object.keys(skip.patch)).not.toContain('contractId');
    });

    it('换绑到另一个合同 → 目标 id 随之改变（不是恒取原值）', () => {
      const first = buildDatasetUpdatePlan({ contractId: CONTRACT_A });
      const second = buildDatasetUpdatePlan({ contractId: CONTRACT_B });
      expect(first.patch.contractId).toBe(CONTRACT_A);
      expect(second.patch.contractId).toBe(CONTRACT_B);
      expect(second.contractIdToValidate).toBe(CONTRACT_B);
    });

    it('空串仍会被要求校验（fail-closed，而不是当成"清除"）', () => {
      // 契约层的 @IsUUID() 本就会 400 拒绝空串；此处兜底保证
      // 万一绕过校验也不会静默写坏外键。
      const plan = buildDatasetUpdatePlan({ contractId: '' });
      expect(plan.contractIdToValidate).toBe('');
    });
  });

  describe('其余字段：空串是合法值（清空），不是"没传"', () => {
    it('source / remark 传空串 → 键存在且为空串（清空不被丢弃）', () => {
      const plan = buildDatasetUpdatePlan({ source: '', remark: '' });
      expect(plan.patch.source).toBe('');
      expect(plan.patch.remark).toBe('');
      expect(Object.keys(plan.patch)).toEqual(
        expect.arrayContaining(['source', 'remark'])
      );
    });

    it('未提供的字段一律不出现在 patch 里', () => {
      const plan = buildDatasetUpdatePlan({ name: '新名字' });
      expect(Object.keys(plan.patch)).toEqual(['name']);
    });

    it('status 可单独更新（下线/上线走 actions 端点，但契约允许）', () => {
      const plan = buildDatasetUpdatePlan({ status: 'offline' });
      expect(plan.patch.status).toBe('offline');
    });

    it('全部字段齐备时逐字段落到 patch', () => {
      const plan = buildDatasetUpdatePlan({
        name: '数据集',
        source: 'CRM 导出',
        maskLevel: 'L3',
        status: 'active',
        remark: '备注',
        contractId: '33333333-3333-4333-8333-333333333333',
      });
      expect(plan.patch).toEqual({
        name: '数据集',
        source: 'CRM 导出',
        maskLevel: 'L3',
        status: 'active',
        remark: '备注',
        contractId: '33333333-3333-4333-8333-333333333333',
      });
    });

    it('空 dto → 空 patch（不会误写任何列）', () => {
      const plan = buildDatasetUpdatePlan({});
      expect(plan.patch).toEqual({});
      expect(plan.contractIdToValidate).toBeNull();
    });

    it('契约允许 maskLevel 为 L1~L4 的任意值（白名单由 DB CHECK 兜底）', () => {
      for (const level of ['L1', 'L2', 'L3', 'L4']) {
        expect(buildDatasetUpdatePlan({ maskLevel: level }).patch.maskLevel).toBe(
          level
        );
      }
    });
  });
});
