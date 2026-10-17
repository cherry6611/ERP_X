#!/usr/bin/env node
/**
 * 表单标签关联门禁（§5.10 / P2-3）：**`<Label>` 必须真的关联到控件**。
 *
 * ## 这个门禁要拦的是什么
 *
 * 仓库里大量形如：
 *
 * ```tsx
 * <div className="grid gap-1">
 *   <Label className="text-xs">待分摊总额</Label>
 *   <Input value={allocAmount} onChange={…} />
 * </div>
 * ```
 *
 * 标签与控件之间**没有任何关联**（既没有 `htmlFor`，控件也没有 `id`）。后果
 * 全部是"不报错、typecheck/lint/单测都看不见"的静默缺陷（WCAG 1.3.1 / 3.3.2）：
 *
 *   · 屏幕阅读器只念"组合框""编辑框"，**不念它是什么字段** —— 表单对读屏用户
 *     等同于一串无名输入框，只能靠 Tab 逐个试；
 *   · 点击标签不会把焦点移到控件上，鼠标用户的可点击区域白白变小；
 *   · 自动化 E2E 只能靠 `placeholder` 或 DOM 位置定位，改文案即碎。
 *
 * ## 审计口径与实测口径的差异（诚实标注）
 *
 * 审计报告（§5.10 / P2-3）写的是"**37 处** `<Label>` 无 `htmlFor`、控件无 `id`"。
 * 实测：审计当时（HEAD `9549ca2`）全仓 `<Label>` 共 170 个，其中无 `htmlFor`
 * 的是 **31 个** —— 审计的 37 多算了 6 个，多出来的部分是**原生小写 `<label>`**
 * 与注释里出现的 `<Label>`（`grep -i` 不区分大小写、也不区分注释）。
 * 两者后果相同，但数字应以实测为准，故此处按 AST 口径检查。
 *
 * ## 判定规则（只拦真缺陷，放行已正确的写法）
 *
 * 对每个 `<Label>` / `<FieldLabel>` 元素依次判定：
 *
 * 1. **包裹式（wrapping）→ 放行**。Radix `Label.Root` 会自动与**嵌套**的
 *    labelable 元素关联，`<Label>金额<Input/></Label>` 本来就是对的。
 * 2. **有 `htmlFor` → 放行**（并额外核对它指向的 `id` 在同文件内存在，
 *    否则是"改了一半"：`htmlFor` 指向不存在的 id 比不关联更隐蔽）。
 * 3. **有 `id` 且该 id 被同文件某个 `aria-labelledby` 引用 → 放行**。
 *    这是复合控件（Radix `SelectTrigger` 渲染的是 `role="combobox"` 的
 *    `<button>`）的正确做法 —— 对它们 `htmlFor` 给不出可访问名。
 * 4. **控件自带 `aria-label` / `aria-labelledby` → 放行**。标签元素只管视觉，
 *    可访问名由控件自己提供，WCAG 3.3.2 已满足。本仓 `FieldLabel` 的调用点
 *    统一走这条（`<SelectTrigger aria-label="成本类型">`），因此这条必须放行，
 *    否则门禁会把已正确的写法全部报掉 —— 误报会让人开始加豁免，最终等于没有检查器。
 * 5. 以上都不满足 → **[FAIL]**。
 *
 * 分组标题（"金额区间"盖住两个输入框、"明细行"盖住一张表）不适用 `htmlFor`：
 * 应写成容器 `role="group"` + `aria-labelledby` 指向标题的 `id`。这类写法命中
 * 规则 3，门禁自动放行；**不要**为了过门禁硬塞一个 `htmlFor` 指到组内第一个
 * 输入框上 —— 那会让读屏器把"整组的名字"念成"第一个字段的名字"，语义是错的。
 *
 * ## 豁免（opt-out）
 *
 * 确有正当理由时，在**同一行或前 4 行内**写注释：
 *
 * ```tsx
 * {/* a11y-ok: 该标签是打印件模板的一部分，不参与无障碍树 *\/}
 * <Label>…</Label>
 * ```
 *
 * 脚本会打印**实际用掉的豁免条数**，避免豁免悄悄堆积成"等于没检查"。
 *
 * ## 已知不覆盖（诚实标注，避免被当成"全查过了"）
 *
 * · **UI 原子组件目录 `client/src/components/ui/` 整体跳过**。那里的
 *   `FieldLabel`（`ui/field.tsx`）是 shadcn 原语，把 `{...props}` 透传给
 *   `<Label>`，自身没有控件可关联，真正的调用点才该被检查。
 * · **`useId()` / 变量形式的 id 无法静态核对**。规则 3 只认"字面量 id 被
 *   字面量 aria-labelledby 引用"；`id={myId}` + `aria-labelledby={myId}` 这种
 *   变量写法抓不到（`erp/FieldLabel.tsx` 的 `htmlFor={htmlFor}` 即属此类）。
 *   同一变量在文件内成对出现，实际风险低于字面量写错，但确实未覆盖。
 * · **`FieldGroupLabel` 的 `onLabelId` 回调是否真被使用**不检查。
 * · **可访问名的内容是否正确**不检查。门禁只证明"有关联"，不证明"名字念得对"
 *   （例如标签写"金额"而字段其实是税额，本脚本无能为力）。
 * · **非 `<Label>` 的裸 `<div>` 伪标签**不检查（本仓已统一走 `<Label>`）。
 * · **同页 id 冲突**不检查。字面量 id 在同一文件内唯一即通过；跨组件、跨文件
 *   的重复 id 只会在运行时暴露（这也是本仓优先用 `useId()` 的原因）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLIENT_SRC = join(ROOT, 'client', 'src');

/** UI 原子组件目录：这里放的是原语本身（props 透传），真正的调用点在别处 */
const PRIMITIVE_DIR = 'client/src/components/ui/';

/** 被检查的标签组件名。`FieldLabel` 渲染的也是 `<Label>`，同样必须关联。 */
const LABEL_TAGS = new Set(['Label', 'FieldLabel']);

/**
 * 视为"控件"的标签名 —— 用于判定包裹式写法的第 1 条规则。
 * 只列本仓真实在用的；Radix 的 `Select` / `Checkbox` 等根组件本身不产出 DOM，
 * 但它们的触发器/子项在上述集合里。
 */
const CONTROL_TAGS = new Set([
  'Input',
  'Textarea',
  'Select',
  'SelectTrigger',
  'NativeSelect',
  'Checkbox',
  'RadioGroupItem',
  'Switch',
  'Slider',
  'InputOTP',
  'Combobox',
  'input',
  'select',
  'textarea',
]);

/** 豁免注释：`{/* a11y-ok: 理由 *\/}`，同一行或前 4 行内 */
const OPT_OUT = /a11y-ok\s*:\s*(.{1,160})/u;
const OPT_OUT_LOOKBACK = 4;

/** 控件自带可访问名时，向标签**之后**看多少行 */
const NEARBY_LOOKAHEAD = 25;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const allFiles = walk(CLIENT_SRC);
const files = allFiles.filter(
  (f) => !relative(ROOT, f).replace(/\\/gu, '/').startsWith(PRIMITIVE_DIR),
);

const problems = [];
const optOuts = [];
const viaAriaOnControl = [];
let labelTotal = 0;
let wrappingTotal = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/gu, '/');
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lines = source.split(/\r?\n/u);

  /* ── 先收集本文件的 id 与 aria-labelledby 引用，供规则 2 / 3 核对 ── */

  /** 本文件声明的字面量 id → 出现行号（用于 htmlFor 的目标核对） */
  const declaredIds = new Map();
  /** 本文件被 `aria-labelledby` 引用的字面量 id */
  const referencedIds = new Set();

  const collectIds = (node) => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const literal =
        ts.isStringLiteral(node.initializer) ? node.initializer.text : null;
      if (literal !== null && (name === 'id' || name === 'aria-labelledby')) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (name === 'id' && !declaredIds.has(literal)) {
          declaredIds.set(literal, line + 1);
        }
        if (name === 'aria-labelledby') referencedIds.add(literal);
      }
      // `aria-labelledby={'x'}` / `aria-labelledby={x}` 里的字面量
      if (name === 'aria-labelledby' && ts.isJsxExpression(node.initializer)) {
        const expr = node.initializer.expression;
        if (expr && ts.isStringLiteral(expr)) referencedIds.add(expr.text);
      }
    }
    ts.forEachChild(node, collectIds);
  };
  collectIds(sf);

  /* ── 逐元素判定 ── */

  const visit = (node) => {
    const isOpening =
      ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
    if (isOpening && LABEL_TAGS.has(node.tagName.getText(sf))) {
      labelTotal += 1;
      const tag = node.tagName.getText(sf);
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const attrNames = attrs.map((a) => a.name.getText(sf));
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const lineNo = line + 1;
      const text = lines[line].trim();

      /* 0. 豁免注释 */
      const window = lines
        .slice(Math.max(0, line - OPT_OUT_LOOKBACK), line + 1)
        .join('\n');
      const optOut = OPT_OUT.exec(window);
      if (optOut) {
        const reason = optOut[1]
          .replace(/[\s*}/]+$/u, '')
          .trim();
        optOuts.push({ file: rel, line: lineNo, reason, text });
        ts.forEachChild(node, visit);
        return;
      }

      /* 1. 包裹式：Radix Label 自动关联嵌套控件 */
      let wraps = false;
      if (ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)) {
        const scan = (n) => {
          if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
            const childTag = (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(sf);
            if (CONTROL_TAGS.has(childTag)) wraps = true;
          }
          ts.forEachChild(n, scan);
        };
        for (const child of node.parent.children) scan(child);
      }
      if (wraps) {
        wrappingTotal += 1;
        ts.forEachChild(node, visit);
        return;
      }

      /* 2. 有 htmlFor：还要核对目标 id 真的存在 */
      const forAttr = attrs.find((a) => a.name.getText(sf) === 'htmlFor');
      if (forAttr) {
        const literal =
          forAttr.initializer && ts.isStringLiteral(forAttr.initializer)
            ? forAttr.initializer.text
            : null;
        if (literal !== null && !declaredIds.has(literal)) {
          problems.push({
            file: rel,
            line: lineNo,
            text,
            why:
              `\`htmlFor="${literal}"\` 在本文件内找不到对应的 \`id\` —— ` +
              '标签指向了一个不存在的元素（比不关联更隐蔽）',
          });
        }
        ts.forEachChild(node, visit);
        return;
      }

      /* 3. 有 id 且被同文件某个 aria-labelledby 引用（复合控件 / 分组标题） */
      const idAttr = attrs.find((a) => a.name.getText(sf) === 'id');
      const ownId =
        idAttr && idAttr.initializer && ts.isStringLiteral(idAttr.initializer)
          ? idAttr.initializer.text
          : null;
      if (ownId !== null && referencedIds.has(ownId)) {
        ts.forEachChild(node, visit);
        return;
      }

      /* 4. 控件自带可访问名（本仓 FieldLabel 调用点的统一写法） */
      const ahead = lines.slice(line, line + NEARBY_LOOKAHEAD).join('\n');
      const controlNamed =
        /aria-label(ledby)?\s*=/u.test(ahead) && /<[A-Za-z]/u.test(ahead);
      if (controlNamed) {
        viaAriaOnControl.push({ file: rel, line: lineNo, text });
        ts.forEachChild(node, visit);
        return;
      }

      /* 5. 真缺陷 */
      problems.push({
        file: rel,
        line: lineNo,
        text,
        why: `\`<${tag}>\` 与控件之间没有任何关联`,
      });
      void attrNames;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

console.log(
  `表单标签关联门禁：扫描 ${files.length} 个 tsx 文件（另有 ` +
    `${allFiles.length - files.length} 个 ui/ 原语跳过），` +
    `共 ${labelTotal} 个 <Label>/<FieldLabel>，` +
    `其中包裹式（自动关联）${wrappingTotal} 个、` +
    `走控件 aria-label 路径 ${viaAriaOnControl.length} 个、` +
    `豁免 ${optOuts.length} 个、` +
    `**未关联 ${problems.length} 个**`,
);

if (optOuts.length > 0) {
  console.log(`\n已使用的 a11y-ok 豁免（${optOuts.length} 条）：`);
  for (const o of optOuts) {
    console.log(`  · ${o.file}:${o.line}  ${o.reason}`);
  }
}

if (problems.length > 0) {
  console.error(
    `\n[FAIL] ${problems.length} 处表单标签关联缺失或指向无效（§5.10 / P2-3，WCAG 1.3.1 / 3.3.2）：\n`,
  );
  for (const p of problems) {
    console.error(`  · ${p.file}:${p.line}  （${p.why}）`);
    console.error(`      ${p.text}`);
  }
  console.error(
    `\n为什么必须修：读屏器只念"组合框""编辑框"而**不念字段名**，表单对读屏\n` +
      `用户等于一串无名输入框；点击标签也不会把焦点移到控件上。这类缺陷不会\n` +
      `报错，typecheck / lint / 单测全都看不见，只能靠本门禁拦。\n` +
      `\n按控件类型选正确的关联方式（**不要**为了过门禁乱加 htmlFor）：\n` +
      `\n  ① 原生控件（Input / Textarea / NativeSelect）—— 加 htmlFor + 控件 id\n` +
      `     <Label htmlFor="aux-allocation-total-amount">待分摊总额</Label>\n` +
      `     <Input id="aux-allocation-total-amount" … />\n` +
      `     id 用「文件 + 字段」的稳定字面量（如 aux-allocation-total-amount），\n` +
      `     便于 grep 与 E2E 定位；不要用随机数或数组下标。\n` +
      `\n  ② 复合控件（Radix Select / Combobox，触发器是 <button>）—— 用\n` +
      `     aria-labelledby，htmlFor 对它们给不出可访问名：\n` +
      `     <Label id="tax-risk-severity-label">严重程度</Label>\n` +
      `     <SelectTrigger aria-labelledby="tax-risk-severity-label">\n` +
      `     也可沿用本仓 FieldLabel 的既有写法：\n` +
      `     <FieldLabel>成本类型</FieldLabel> + <SelectTrigger aria-label="成本类型">\n` +
      `\n  ③ 分组标题（盖上两个输入框 / 一张表，不是单个控件的标签）——\n` +
      `     htmlFor 在这里**没有**可指向的单一控件，硬塞会指向组内第一个\n` +
      `     输入框，让读屏器把组名念成第一个字段名。正确写法是容器\n` +
      `     role="group" + aria-labelledby 指向标题 id：\n` +
      `     <div role="group" aria-labelledby="quotation-items-label">\n` +
      `       <Label id="quotation-items-label">明细行</Label> …\n` +
      `\n  ④ 确实不需要关联（如打印件模板）—— 在同一行或前 4 行写\n` +
      `     {/* a11y-ok: 理由 */}，脚本会统计并打印豁免条数。`,
  );
  process.exit(1);
}

console.log(
  '表单标签关联门禁通过：所有 <Label> 均已关联到控件（htmlFor / aria-labelledby）。',
);
