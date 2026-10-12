import type { DepartmentInfo } from '@client/src/platform/services';

import type { Department } from './types';

export function getDepartmentDisplayName(name: DepartmentInfo['name']): string {
  return name?.zh_cn || name?.en_us || '';
}

export function departmentInfoToDepartment(
  departmentInfo: DepartmentInfo,
): Department {
  return {
    id: departmentInfo.departmentID,
    name: getDepartmentDisplayName(departmentInfo.name),
    raw: departmentInfo,
  };
}
