/** 数据集是否落在当前用户可见的合同范围内。未关联合同的数据集对收窄用户不可见。 */
export function datasetInScope(
  contractId: string | null | undefined,
  scope: { unrestricted: true } | { unrestricted: false; contractIds: string[] },
): boolean {
  if (scope.unrestricted) return true;
  if (!contractId) return false;
  return scope.contractIds.includes(contractId);
}
