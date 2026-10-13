import {
  buildRedflushSourceRef,
  isRedflushSourceRef,
} from './redflush-ref';

describe('costs redflush sourceRef', () => {
  it('格式为 redflush:<原成本单号>', () => {
    expect(buildRedflushSourceRef('CST20261014001')).toBe(
      'redflush:CST20261014001'
    );
  });

  it('isRedflushSourceRef 识别红冲记录', () => {
    expect(isRedflushSourceRef('redflush:CST1')).toBe(true);
    expect(isRedflushSourceRef('po:PO1')).toBe(false);
    expect(isRedflushSourceRef(null)).toBe(false);
  });
});
