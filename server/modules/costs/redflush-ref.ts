/** 成本红冲 sourceRef 约定：`redflush:<原成本单号>`（与唯一索引一致）。 */
export function buildRedflushSourceRef(costCode: string): string {
  return `redflush:${costCode}`;
}

export function isRedflushSourceRef(sourceRef: string | null | undefined): boolean {
  return (sourceRef ?? '').startsWith('redflush:');
}
