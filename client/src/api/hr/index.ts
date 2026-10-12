import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  AddTrainingAttendeesDto,
  AppraisalAction,
  AppraisalItem,
  AttendanceAmendment,
  AttendanceAmendmentAction,
  AttendanceRecord,
  CreateAttendanceAmendmentDto,
  Candidate,
  CandidateAction,
  CreateAppraisalDto,
  CreateCandidateDto,
  CreateDepartmentDto,
  CreateEmployeeDto,
  CreateLeaveRequestDto,
  CreatePayrollDto,
  CreatePositionDto,
  CreateRecruitReqDto,
  CreateTrainingDto,
  Department,
  Employee,
  HrOverview,
  InitLeaveBalancesDto,
  InitLeaveBalancesResult,
  LeaveBalance,
  LeaveRequest,
  LeaveRequestAction,
  MyHrSummary,
  OffboardEmployeeDto,
  OffboardResult,
  PayrollAction,
  PayrollItem,
  Position,
  RecruitReq,
  SetLeaveBalanceDto,
  Training,
  TrainingAction,
  UpdateDepartmentDto,
  UpdateEmployeeDto,
  UpdatePositionDto,
  UpsertAttendanceDto,
} from '@shared/api.interface';

/* ========== 组织与员工 ========== */

export async function listDepartments(): Promise<Department[]> {
  const resp = await axiosForBackend.get<Department[]>('/api/hr/departments');
  return resp.data;
}

export async function createDepartment(dto: CreateDepartmentDto): Promise<Department> {
  const resp = await axiosForBackend.post<Department>('/api/hr/departments', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateDepartment(id: string, dto: UpdateDepartmentDto): Promise<Department> {
  const resp = await axiosForBackend.patch<Department>(`/api/hr/departments/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listPositions(): Promise<Position[]> {
  const resp = await axiosForBackend.get<Position[]>('/api/hr/positions');
  return resp.data;
}

export async function createPosition(dto: CreatePositionDto): Promise<Position> {
  const resp = await axiosForBackend.post<Position>('/api/hr/positions', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updatePosition(id: string, dto: UpdatePositionDto): Promise<Position> {
  const resp = await axiosForBackend.patch<Position>(`/api/hr/positions/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listEmployees(keyword?: string): Promise<Employee[]> {
  const resp = await axiosForBackend.get<Employee[]>('/api/hr/employees', {
    params: keyword ? { keyword } : undefined,
  });
  return resp.data;
}

export async function createEmployee(dto: CreateEmployeeDto): Promise<Employee> {
  const resp = await axiosForBackend.post<Employee>('/api/hr/employees', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateEmployee(id: string, dto: UpdateEmployeeDto): Promise<Employee> {
  const resp = await axiosForBackend.patch<Employee>(`/api/hr/employees/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

/** 当前登录用户绑定的员工；未绑定返回 null */
export async function fetchMyEmployee(): Promise<Employee | null> {
  const resp = await axiosForBackend.get<Employee | null>('/api/hr/employees/me');
  return resp.data;
}

/* ========== 考勤与请假 ========== */

export async function listAttendance(
  month?: string,
  employeeId?: string,
): Promise<AttendanceRecord[]> {
  const resp = await axiosForBackend.get<AttendanceRecord[]>('/api/hr/attendance', {
    params: {
      ...(month ? { month } : {}),
      ...(employeeId ? { employeeId } : {}),
    },
  });
  return resp.data;
}

export async function createAttendance(dto: UpsertAttendanceDto): Promise<AttendanceRecord> {
  const resp = await axiosForBackend.post<AttendanceRecord>('/api/hr/attendance', dto);
  return resp.data;
}

export async function listLeaveBalances(year?: string): Promise<LeaveBalance[]> {
  const resp = await axiosForBackend.get<LeaveBalance[]>('/api/hr/leave-balances', {
    params: year ? { year } : undefined,
  });
  return resp.data;
}

export async function setLeaveBalance(dto: SetLeaveBalanceDto): Promise<LeaveBalance> {
  const resp = await axiosForBackend.post<LeaveBalance>('/api/hr/leave-balances', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listLeaveRequests(
  status?: string,
  employeeId?: string,
): Promise<LeaveRequest[]> {
  const resp = await axiosForBackend.get<LeaveRequest[]>('/api/hr/leave-requests', {
    params: {
      ...(status ? { status } : {}),
      ...(employeeId ? { employeeId } : {}),
    },
  });
  return resp.data;
}

export async function createLeaveRequest(dto: CreateLeaveRequestDto): Promise<LeaveRequest> {
  const resp = await axiosForBackend.post<LeaveRequest>('/api/hr/leave-requests', dto);
  return resp.data;
}

export async function leaveRequestAction(
  id: string,
  action: LeaveRequestAction,
): Promise<LeaveRequest> {
  const resp = await axiosForBackend.post<LeaveRequest>(`/api/hr/leave-requests/${id}/actions`, {
    action,
  });
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 薪酬 ========== */

export async function listMyPayrolls(period?: string, status?: string): Promise<PayrollItem[]> {
  const resp = await axiosForBackend.get<PayrollItem[]>('/api/hr/my/payrolls', {
    params: {
      ...(period ? { period } : {}),
      ...(status ? { status } : {}),
    },
  });
  return resp.data;
}

export async function listPayrolls(period?: string, status?: string): Promise<PayrollItem[]> {
  try {
    const resp = await axiosForBackend.get<PayrollItem[]>('/api/hr/payrolls', {
      params: {
        ...(period ? { period } : {}),
        ...(status ? { status } : {}),
      },
    });
    return resp.data;
  } catch (error: unknown) {
    const statusCode: number | undefined =
      error !== null &&
      typeof error === 'object' &&
      'response' in error &&
      error.response !== null &&
      typeof error.response === 'object' &&
      'status' in error.response &&
      typeof error.response.status === 'number'
        ? error.response.status
        : undefined;
    if (statusCode === 403) return listMyPayrolls(period, status);
    throw error;
  }
}

export async function createPayroll(dto: CreatePayrollDto): Promise<PayrollItem> {
  const resp = await axiosForBackend.post<PayrollItem>('/api/hr/payrolls', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function payrollAction(id: string, action: PayrollAction): Promise<PayrollItem> {
  const resp = await axiosForBackend.post<PayrollItem>(`/api/hr/payrolls/${id}/actions`, {
    action,
  });
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 招聘 ========== */

export async function listRecruitReqs(): Promise<RecruitReq[]> {
  const resp = await axiosForBackend.get<RecruitReq[]>('/api/hr/recruit-reqs');
  return resp.data;
}

export async function createRecruitReq(dto: CreateRecruitReqDto): Promise<RecruitReq> {
  const resp = await axiosForBackend.post<RecruitReq>('/api/hr/recruit-reqs', dto);
  return resp.data;
}

export async function listCandidates(reqId?: string): Promise<Candidate[]> {
  const resp = await axiosForBackend.get<Candidate[]>('/api/hr/candidates', {
    params: reqId ? { reqId } : undefined,
  });
  return resp.data;
}

export async function createCandidate(dto: CreateCandidateDto): Promise<Candidate> {
  const resp = await axiosForBackend.post<Candidate>('/api/hr/candidates', dto);
  return resp.data;
}

export async function candidateAction(id: string, action: CandidateAction): Promise<Candidate> {
  const resp = await axiosForBackend.post<Candidate>(`/api/hr/candidates/${id}/actions`, {
    action,
  });
  return resp.data;
}

/* ========== 绩效与培训 ========== */

export async function listAppraisals(period?: string): Promise<AppraisalItem[]> {
  const resp = await axiosForBackend.get<AppraisalItem[]>('/api/hr/appraisals', {
    params: period ? { period } : undefined,
  });
  return resp.data;
}

export async function createAppraisal(dto: CreateAppraisalDto): Promise<AppraisalItem> {
  const resp = await axiosForBackend.post<AppraisalItem>('/api/hr/appraisals', dto);
  return resp.data;
}

export async function appraisalAction(id: string, action: AppraisalAction): Promise<AppraisalItem> {
  const resp = await axiosForBackend.post<AppraisalItem>(`/api/hr/appraisals/${id}/actions`, {
    action,
  });
  return resp.data;
}

export async function listTrainings(): Promise<Training[]> {
  const resp = await axiosForBackend.get<Training[]>('/api/hr/trainings');
  return resp.data;
}

export async function createTraining(dto: CreateTrainingDto): Promise<Training> {
  const resp = await axiosForBackend.post<Training>('/api/hr/trainings', dto);
  return resp.data;
}

export async function addTrainingAttendees(
  id: string,
  employeeIds: string[],
): Promise<Training> {
  const dto: AddTrainingAttendeesDto = { trainingId: id, employeeIds };
  const resp = await axiosForBackend.post<Training>(`/api/hr/trainings/${id}/attendees`, dto);
  return resp.data;
}

export async function trainingAction(id: string, action: TrainingAction): Promise<Training> {
  const resp = await axiosForBackend.post<Training>(`/api/hr/trainings/${id}/actions`, {
    action,
  });
  return resp.data;
}

/* ========== 员工自助与补卡（三期） ========== */

export async function getMyHrSummary(): Promise<MyHrSummary> {
  const resp = await axiosForBackend.get<MyHrSummary>('/api/hr/my/summary');
  return resp.data;
}

export async function listAttendanceAmendments(
  status?: string,
): Promise<AttendanceAmendment[]> {
  const resp = await axiosForBackend.get<AttendanceAmendment[]>('/api/hr/attendance-amendments', {
    params: status ? { status } : undefined,
  });
  return resp.data;
}

export async function createAttendanceAmendment(
  dto: CreateAttendanceAmendmentDto,
): Promise<AttendanceAmendment> {
  const resp = await axiosForBackend.post<AttendanceAmendment>('/api/hr/attendance-amendments', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function attendanceAmendmentAction(
  id: string,
  action: AttendanceAmendmentAction,
): Promise<AttendanceAmendment> {
  const resp = await axiosForBackend.post<AttendanceAmendment>(
    `/api/hr/attendance-amendments/${id}/actions`,
    { action },
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function initLeaveBalances(year: string): Promise<InitLeaveBalancesResult> {
  const dto: InitLeaveBalancesDto = { year };
  const resp = await axiosForBackend.post<InitLeaveBalancesResult>(
    '/api/hr/leave-balances/init',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function offboardEmployee(
  id: string,
  dto: OffboardEmployeeDto,
): Promise<OffboardResult> {
  const resp = await axiosForBackend.post<OffboardResult>(`/api/hr/employees/${id}/offboard`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 人力看板 ========== */

export async function getHrOverview(): Promise<HrOverview> {
  const resp = await axiosForBackend.get<HrOverview>('/api/bi/hr-overview');
  return resp.data;
}
