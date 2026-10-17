/**
 * 行身份生成器（P-2：可增删行的表格不得用数组下标作 React key）。
 *
 * 为什么不用 `crypto.randomUUID()`：它只在**安全上下文**（HTTPS 或 localhost）可用。
 * 本系统存在用内网 IP + 明文 HTTP 部署的方式，那种环境下该 API 是 undefined，
 * 调用会直接抛 `TypeError`，把报价单/分摊面板整页打挂——用下标顶多错位，用它是崩页面。
 * 所以这里做能力探测降级；两类分支生成的值都不依赖渲染时机（在**创建行时**调用一次），
 * 因此重渲染不会让 key 变化（否则比下标还差）。
 */
let rowKeySeq = 0;

export function newRowKey(): string {
  const cryptoRef: Crypto | undefined =
    typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  rowKeySeq += 1;
  return `row-${rowKeySeq}-${Math.random().toString(36).slice(2, 10)}`;
}
