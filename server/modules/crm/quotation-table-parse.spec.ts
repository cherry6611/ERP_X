import { tryParseQuotationTable } from './quotation-table-parse';

describe('tryParseQuotationTable', () => {
  it('parses tab table with 类别/单价/数量/工期', () => {
    const text = [
      '# 心率数据采集项目',
      '序号\t类别\t单价（元）\t单位\t数量\t工期\t金额（元）\t备注',
      '1\t项目PM\t500\t人\t1\t19\t9500\t',
      '2\tPolar H10心率带\t42.86\t台\t6\t19\t4880.4\t租赁/采购',
      '3\t合计\t\t\t\t\t14380.4\t',
    ].join('\n');
    const draft = tryParseQuotationTable(text);
    expect(draft).not.toBeNull();
    expect(draft!.title).toBe('心率数据采集项目');
    expect(draft!.items).toHaveLength(2);
    expect(draft!.items[0]).toMatchObject({
      itemName: '项目PM',
      quantity: 19,
      unitPrice: 500,
      unit: '人天',
    });
    expect(draft!.items[1]).toMatchObject({
      itemName: 'Polar H10心率带',
      quantity: 114,
      unitPrice: 42.86,
      unit: '台·天',
    });
  });
});
