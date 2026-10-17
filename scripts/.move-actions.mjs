/**
 * 把 4 个列表页的**写操作**从筛选行移到 `PageShell.actions`（页头右侧）。
 *
 * ## 统一判据（本仓 AGENTS.md）
 *
 * | 类别 | 例子 | 放哪 |
 * |---|---|---|
 * | **主操作 / 写操作** | 新建、登记、导入、同步（会写外部系统）、执行 | `PageShell.actions`（页头右侧） |
 * | **对当前筛选结果的只读工具** | 导出 Excel、打印、刷新 | 留在筛选行 |
 * | 筛选控件 | 搜索、状态、主体 | 留在筛选行 |
 *
 * 依据：页头主操作位是使用者"想做事时先看的地方"；筛选行是"调整看什么"的地方。
 * 原来 4 个页面都把「新建/登记」塞在筛选行末尾、和「导出」并排，导致：
 *   · 主操作不显眼（一长排控件里最后一个小按钮）；
 *   · 同一页两处"操作区"，位置随筛选控件数量漂移。
 *
 * 脚本只做**搬运**（把 JSX 块从头挪到尾），不改行为。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const JOBS = [
  {
    file: 'client/src/pages/customers/CustomersPage.tsx',
    // 从筛选行搬走的块：新建客户 + 导入 Excel（导出留下）
    moves: [
      {
        label: '新建客户',
        open: '        <CanCapabilityWrite capability="crm_write">\n          <Button onClick={openCreate}>',
        close: '        </CanCapabilityWrite>\n',
      },
      {
        label: '导入 Excel',
        open: '        <CanCapabilityWrite capability="crm_write">\n          <Button variant="outline" onClick={() => setImportOpen(true)}>',
        close: '        </CanCapabilityWrite>\n',
      },
    ],
  },
];

/** 从 src 中取出 open..close 之间的整块（含两端），并删除它 */
function cutBlock(src, open, close) {
  const a = src.indexOf(open);
  if (a < 0) return { src, block: null, why: 'open 未命中' };
  const b = src.indexOf(close, a + open.length);
  if (b < 0) return { src, block: null, why: 'close 未命中' };
  const end = b + close.length;
  const block = src.slice(a, end);
  return { src: src.slice(0, a) + src.slice(end), block, why: null };
}

for (const job of JOBS) {
  let src = readFileSync(job.file, 'utf8');
  const collected = [];
  for (const mv of job.moves) {
    const r = cutBlock(src, mv.open, mv.close);
    if (!r.block) {
      console.log(`  ! ${job.file} [${mv.label}] ${r.why}`);
      continue;
    }
    src = r.src;
    collected.push(r.block);
    console.log(`  ✓ ${job.file} 剪出 [${mv.label}]`);
  }
  if (collected.length === 0) continue;
  writeFileSync(`${job.file}.cut`, src + '\n/*CUT-MARK*/\n' + collected.join(''), 'utf8');
  console.log(`  → 已写出 ${job.file}.cut 供下一步拼装`);
}
console.log('\n完成（仅剪出，未回写）');
