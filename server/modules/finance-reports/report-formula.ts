/**
 * 法定财务报表取数公式 DSL（A-01 / A-02）。
 *
 * 设计目标：
 * - 报表模板落库（`fin_report_template.formula`），改口径不需要发版；
 * - 语法极小、可解释、可单测，避免引入表达式引擎依赖；
 * - 显式区分"科目余额/发生额"与"表内其他行引用"，避免循环引用。
 *
 * 语法（BNF 概要）：
 *   formula   := term (('+' | '-') term)*
 *   term      := atom
 *   atom      := number
 *              | '科目余额' '(' code [',' 方向] ')'
 *              | '科目发生' '(' code [',' 方向] ')'
 *              | '期初余额' '(' code [',' 方向] ')'
 *              | '上期' '(' rowNo ')'
 *              | '行' '(' rowNo ')'
 *              | 'ABS' '(' formula ')'
 *              | '(' formula ')'
 *   方向      := '期末' | '期初' | '借' | '贷' | '净'   （缺省 '净'）
 *
 * 语义：
 * - `科目余额(code, '净')`  = 借方余额 − 贷方余额（可正可负，报表按需要取号）；
 * - `科目余额(code, '借')`  = max(借方余额 − 贷方余额, 0)；
 * - `科目余额(code, '贷')`  = max(贷方余额 − 借方余额, 0)；
 * - `科目发生(code, dir)`   = 本期发生额（同方向规则）；
 * - `期初余额(code, dir)`   = 期初余额（同方向规则）；
 * - `上期(rowNo)`           = 上一期间的同一行次结果（跨期比较列）；
 * - `行(rowNo)`             = 本表其他行次结果（支持"其中："与小计引用）。
 *
 * 所有金额按分四舍五入到 2 位小数。
 */

export type BalanceDirection = 'net' | 'debit' | 'credit' | 'closing' | 'opening';

export interface FormulaAccountRef {
  kind: 'balance' | 'occurrence' | 'opening' | 'change';
  code: string;
  direction: BalanceDirection;
}

export interface FormulaRowRef {
  kind: 'prev' | 'row';
  rowNo: string;
}

export type FormulaNode =
  | { type: 'number'; value: number }
  | { type: 'account'; ref: FormulaAccountRef; sign: 1 | -1 }
  | { type: 'row'; ref: FormulaRowRef; sign: 1 | -1 }
  | { type: 'plnet'; sign: 1 | -1 }
  | { type: 'group'; nodes: FormulaNode[]; sign: 1 | -1 }
  | { type: 'abs'; node: FormulaNode; sign: 1 | -1 }
  | { type: 'mul'; nodes: FormulaNode[]; sign: 1 | -1 };

export interface ParsedFormula {
  nodes: FormulaNode[];
  /** 公式引用的科目编码（用于一次性批量取数） */
  accountCodes: string[];
  /** 公式引用的行次（用于拓扑排序，先算被依赖行） */
  rowRefs: string[];
  /** 是否引用了上一期间（跨期比较） */
  usesPrevPeriod: boolean;
}

export class FormulaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaParseError';
  }
}

const DIRECTION_ALIASES: Record<string, BalanceDirection> = {
  净: 'net',
  期末: 'closing',
  期初: 'opening',
  借: 'debit',
  贷: 'credit',
};

const ACCOUNT_FUNCS: Record<string, FormulaAccountRef['kind']> = {
  科目余额: 'balance',
  科目发生: 'occurrence',
  期初余额: 'opening',
  /** 期间变动额 = 期末(借−贷) − 期初(借−贷)，用于间接法现金流量表推算营运资本变动 */
  科目变动: 'change',
};

/** 解析公式文本；空公式合法（结果恒为 0，用于纯标题行） */
export function parseFormula(input: string): ParsedFormula {
  const text = (input ?? '').trim();
  const result: ParsedFormula = {
    nodes: [],
    accountCodes: [],
    rowRefs: [],
    usesPrevPeriod: false,
  };
  if (text === '') return result;

  const tokens = tokenize(text);
  let index = 0;

  const peek = (): string | undefined => tokens[index];
  const next = (): string => {
    const token = tokens[index];
    if (token === undefined) {
      throw new FormulaParseError(`公式意外结束：${text}`);
    }
    index += 1;
    return token;
  };

  /**
   * 加法层（二元 +/-，左结合）：
   *   expression := ['-'] product (('+' | '-') product)*
   * 返回节点数组，数组元素之间按"相加"语义求和；负号通过节点 sign 表达。
   */
  function parseExpression(): FormulaNode[] {
    const nodes: FormulaNode[] = [];
    let pendingSign: 1 | -1 = 1;
    let started = false;
    for (;;) {
      const token = peek();
      if (token === undefined) break;
      if (!started && token === '+') {
        index += 1;
        started = true;
        continue;
      }
      if (!started && token === '-') {
        index += 1;
        pendingSign = -1;
        started = true;
        continue;
      }
      if (started && token === '+') {
        index += 1;
        pendingSign = 1;
        started = false;
        continue;
      }
      if (started && token === '-') {
        index += 1;
        pendingSign = -1;
        started = false;
        continue;
      }
      if (started) {
        // 已有一个完整操作数，且下一个 token 既不是运算符也不是结尾 → 语法错误
        // （右括号属于外层表达式终止符，交由调用方消费）
        if (token === ')') break;
        throw new FormulaParseError(`运算符缺失或位置错误：${text}`);
      }
      const node = parseProduct();
      nodes.push(applySign(node, pendingSign));
      pendingSign = 1;
      started = true;
    }
    if (!started && nodes.length > 0) {
      throw new FormulaParseError(`公式以运算符结尾：${text}`);
    }
    return nodes;
  }

  /**
   * 乘法层（左结合）：
   *   product := ['-'] term ('*' ['-'] term)*
   * 支持 `-1 * 科目变动(1122)` 与 `2 * (行(1) - 行(2))` 这类写法。
   */
  function parseProduct(): FormulaNode {
    const factors: FormulaNode[] = [];
    let pendingSign: 1 | -1 = 1;
    let expectFactor = true;
    for (;;) {
      const token = peek();
      if (token === undefined) break;
      if (token === '*') {
        index += 1;
        expectFactor = true;
        continue;
      }
      if (expectFactor && token === '-') {
        index += 1;
        pendingSign = -1;
        continue;
      }
      if (!expectFactor) break;
      const factor = parseTerm();
      factors.push(applySign(factor, pendingSign));
      pendingSign = 1;
      expectFactor = false;
    }
    if (factors.length === 0) {
      throw new FormulaParseError(`缺少操作数：${text}`);
    }
    if (factors.length === 1) return factors[0];
    return { type: 'mul', nodes: factors, sign: 1 };
  }

  function parseTerm(): FormulaNode {
    const token = next();
    if (token === '(') {
      const inner = parseExpression();
      const close = next();
      if (close !== ')') throw new FormulaParseError(`缺少右括号：${text}`);
      return { type: 'group', nodes: inner, sign: 1 };
    }
    if (/^-?\d+(\.\d+)?$/.test(token)) {
      return { type: 'number', value: Number(token) };
    }
    if (token === 'ABS') {
      const open = next();
      if (open !== '(') throw new FormulaParseError(`ABS 缺少左括号：${text}`);
      const inner = parseExpression();
      const close = next();
      if (close !== ')') throw new FormulaParseError(`ABS 缺少右括号：${text}`);
      return {
        type: 'abs',
        node: inner.length === 1 ? inner[0] : { type: 'group', nodes: inner, sign: 1 },
        sign: 1,
      };
    }
    const accountKind = ACCOUNT_FUNCS[token];
    if (accountKind) {
      const open = next();
      if (open !== '(') throw new FormulaParseError(`${token} 缺少左括号：${text}`);
      const code = next();
      if (!/^\d{3,10}$/.test(code)) {
        throw new FormulaParseError(`${token} 的科目编码非法：${code}`);
      }
      let direction: BalanceDirection = 'net';
      if (peek() === ',') {
        index += 1;
        const dirToken = next().replace(/^['"]|['"]$/g, '');
        const mapped = DIRECTION_ALIASES[dirToken];
        if (!mapped) {
          throw new FormulaParseError(
            `${token} 的方向非法：${dirToken}（支持 净/期初/期末/借/贷）`
          );
        }
        direction = mapped;
      }
      const close = next();
      if (close !== ')') throw new FormulaParseError(`${token} 缺少右括号：${text}`);
      if (!result.accountCodes.includes(code)) result.accountCodes.push(code);
      return {
        type: 'account',
        ref: { kind: accountKind, code, direction },
        sign: 1,
      };
    }
    if (token === '上期' || token === '行') {
      const open = next();
      if (open !== '(') throw new FormulaParseError(`${token} 缺少左括号：${text}`);
      const rowNo = next().replace(/^['"]|['"]$/g, '');
      const close = next();
      if (close !== ')') throw new FormulaParseError(`${token} 缺少右括号：${text}`);
      if (token === '上期') result.usesPrevPeriod = true;
      if (!result.rowRefs.includes(rowNo)) result.rowRefs.push(rowNo);
      return {
        type: 'row',
        ref: { kind: token === '上期' ? 'prev' : 'row', rowNo },
        sign: 1,
      };
    }
    /** 本年损益净额()：取本会计年度至当前期间的损益类科目净额合计，
     * 用于资产负债表"未分配利润"在未做年终结转（4103 为空）时纳入本期利润，
     * 使月度资产负债表恒等式通过。年终结转后损益科目清零、4103 承接，不会重复计算。 */
    if (token === '本年损益净额') {
      const open = next();
      if (open !== '(') throw new FormulaParseError(`${token} 缺少左括号：${text}`);
      const close = next();
      if (close !== ')') throw new FormulaParseError(`${token} 缺少右括号：${text}`);
      return { type: 'plnet', sign: 1 };
    }
    throw new FormulaParseError(`无法识别的公式片段：${token}（完整公式：${text}）`);
  }

  result.nodes = parseExpression();
  if (index !== tokens.length) {
    throw new FormulaParseError(`公式存在多余片段：${tokens.slice(index).join('')}`);
  }
  return result;
}

function applySign(node: FormulaNode, sign: 1 | -1): FormulaNode {
  if (sign === 1) return node;
  if (node.type === 'number') return { type: 'number', value: -node.value };
  return { ...node, sign: (node.sign * -1) as 1 | -1 };
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (
      char === '+' ||
      char === '-' ||
      char === '*' ||
      char === '(' ||
      char === ')' ||
      char === ','
    ) {
      if (char === '-' && (tokens.length === 0 || tokens[tokens.length - 1] === '(' || tokens[tokens.length - 1] === '*' || tokens[tokens.length - 1] === '+' || tokens[tokens.length - 1] === '-')) {
        // 一元负号：并入后续数字（如 -1）
        const match = /^-\d+(\.\d+)?/.exec(text.slice(index));
        if (match) {
          tokens.push(match[0]);
          index += match[0].length;
          continue;
        }
      }
      tokens.push(char);
      index += 1;
      continue;
    }
    if (/[\d.]/.test(char)) {
      const match = /^\d+(\.\d+)?/.exec(text.slice(index));
      if (!match) throw new FormulaParseError(`数字格式错误：${text.slice(index, index + 8)}`);
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    // 中文函数名 / 行号 / 引号字符串
    const match = /^[^\s+\-(),]+/.exec(text.slice(index));
    if (!match) throw new FormulaParseError(`无法解析：${text.slice(index, index + 8)}`);
    tokens.push(match[0]);
    index += match[0].length;
  }
  return tokens;
}

/** 单行取数上下文 */
export interface FormulaContext {
  /** accountCode → 该科目（含下级汇总后）的借方/贷方余额与发生额 */
  accountValues: Map<string, FormulaAccountValues>;
  /** 行次 → 本表已算出的结果 */
  rowValues: Map<string, number>;
  /** 行次 → 上一期间结果 */
  prevRowValues: Map<string, number>;
  /** 本年损益净额（资产负债表用）：本会计年度至当前期间损益类科目净额合计 */
  plNet?: number;
}

export interface FormulaAccountValues {
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
  /** 科目名称（用于报表下钻明细展示，非必需） */
  name?: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function directionValue(
  values: {
    openingDebit: number;
    openingCredit: number;
    debitOccur: number;
    creditOccur: number;
    closingDebit: number;
    closingCredit: number;
  },
  kind: FormulaAccountRef['kind'],
  direction: BalanceDirection
): number {
  if (kind === 'change') {
    const net = round2(
      values.closingDebit - values.closingCredit - (values.openingDebit - values.openingCredit)
    );
    switch (direction) {
      case 'debit':
        return Math.max(net, 0);
      case 'credit':
        return Math.max(-net, 0);
      default:
        return net;
    }
  }
  const debit =
    kind === 'occurrence'
      ? values.debitOccur
      : kind === 'opening'
        ? values.openingDebit
        : values.closingDebit;
  const credit =
    kind === 'occurrence'
      ? values.creditOccur
      : kind === 'opening'
        ? values.openingCredit
        : values.closingCredit;
  switch (direction) {
    case 'debit':
      return Math.max(round2(debit - credit), 0);
    case 'credit':
      return Math.max(round2(credit - debit), 0);
    case 'opening':
    case 'closing':
    case 'net':
    default:
      return round2(debit - credit);
  }
}

function evalNode(node: FormulaNode, ctx: FormulaContext): number {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'account': {
      const values = ctx.accountValues.get(node.ref.code);
      if (!values) return 0;
      return node.sign * directionValue(values, node.ref.kind, node.ref.direction);
    }
    case 'row': {
      const map = node.ref.kind === 'prev' ? ctx.prevRowValues : ctx.rowValues;
      const value = map.get(node.ref.rowNo);
      return node.sign * (value ?? 0);
    }
    case 'plnet':
      return node.sign * (ctx.plNet ?? 0);
    case 'group': {
      let total = 0;
      for (const child of node.nodes) total += evalNode(child, ctx);
      return node.sign * total;
    }
    case 'mul': {
      let product = 1;
      for (const child of node.nodes) product *= evalNode(child, ctx);
      return node.sign * product;
    }
    case 'abs':
      return node.sign * Math.abs(evalNode(node.node, ctx));
    default:
      return 0;
  }
}

/** 计算解析后的公式结果 */
export function evaluateFormula(parsed: ParsedFormula, ctx: FormulaContext): number {
  let total = 0;
  for (const node of parsed.nodes) {
    total += evalNode(node, ctx);
  }
  return round2(total);
}
