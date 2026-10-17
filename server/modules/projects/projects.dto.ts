import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import type {
  AcceptDeliverableDto as IAcceptDeliverableDto,
  CreateDeliverableDto as ICreateDeliverableDto,
  CreateProjectChangeDto as ICreateProjectChangeDto,
  CreateProjectDto as ICreateProjectDto,
  CreateProjectMilestoneDto as ICreateProjectMilestoneDto,
  CreateProjectMinutesDto as ICreateProjectMinutesDto,
  CreateProjectRevenueDto as ICreateProjectRevenueDto,
  ProjectMilestoneCloseDto as IProjectMilestoneCloseDto,
  ProjectStatusAction,
  UpdateDeliverableDto as IUpdateDeliverableDto,
  UpdateProjectDto as IUpdateProjectDto,
} from '@shared/api.interface';

/**
 * 项目模块请求体 DTO（API-1 / NFR-M3）。
 *
 * 为什么必须用 class 而不是 interface：Nest 的 `ValidationPipe` 通过 **metatype**
 * 反射装饰器元数据；`interface` 与内联对象类型在运行时被擦除，管道会静默放行任意
 * 请求体（需求书 §1.2 记录的"20+ 处零校验 @Body()"）。这些 class 均 `implements`
 * shared 中的契约类型，保证前后端字段同源。
 *
 * 校验口径（需求书 §7.1）：金额 `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min`，
 * 期间 `@Matches(/^\d{4}-(0[1-9]|1[0-2])$/)`，UUID `@IsUUID()`，
 * 可空外键 `@IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()`。
 */

const CHANGE_TYPES = ['scope', 'budget', 'schedule'] as const;

const DELIVERABLE_TYPES = [
  'dataset',
  'report',
  'software',
  'doc',
  'other',
] as const;

// 与 shared MINUTES_TYPES 逐字一致（值有出入会直接导致 tsc 拒绝赋值）
const MINUTES_TYPES = ['weekly_report', 'meeting'] as const;

/*
 * B6（§7.2）：白名单必须与 `ProjectStatusAction` 联合类型**同步**。
 *
 * 这个 `@IsIn` 是一道真实闸门 —— 只加类型、漏了这里，
 * 前端点「取消项目」会得到 400「项目状态操作不合法」，
 * 而后端 service 里明明已经写好分支、UI 上按钮也渲染了。
 *
 * `cancel` / `reopen` 是本轮新增的**退出路径**：原表只有 4 条正向流转，
 * 导致项目一进入非终态就无法退出（同合同下"全部项目已结项"永不成立，
 * 合同状态卡在 active），且已结项无法撤回。
 */
const PROJECT_STATUS_ACTIONS = [
  'approve',
  'deliver',
  'accept',
  'close',
  'cancel',
  'reopen',
] as const;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * 可空 UUID：字段存在且为 null 时放行（PATCH 语义下"显式清除"）。
 *
 * 不能只写 `@IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()`：
 * `@ValidateIf` 返回 false 时 `@IsOptional` 已使全部约束短路，等于不校验字符串。
 * 这里用显式 null 放行的自定义约束，保证「非 null 即必须合法 UUID」。
 */
function IsNullableUuid(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isNullableUuid',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean =>
          value === null || value === undefined || isUuidLike(value),
      },
    });
  };
}

function isUuidLike(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value
  );
}

/* ========== 项目 ========== */

export class CreateProjectDto implements ICreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsUUID()
  contractId!: string;

  @IsOptional()
  @IsUUID()
  wonQuotationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  pm?: string;

  /** 项目经理系统用户 ID（varchar(64)，非 UUID，勿加 @IsUUID） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  pmUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deptName?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  budget?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  estimatedTotalCost?: number;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;
}

export class UpdateProjectDto implements IUpdateProjectDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  pm?: string;

  /** 传 null 表示清除项目经理用户 */
  @IsOptional()
  @IsNullableUuid()
  pmUserId?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  budget?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  estimatedTotalCost?: number;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  /** 选定最终成交报价单；传 null 清除 */
  @IsOptional()
  @IsNullableUuid()
  wonQuotationId?: string | null;
}

/* ========== 项目状态流转 / 结项 ========== */

export class ProjectStatusActionDto {
  @IsString()
  @IsIn([...PROJECT_STATUS_ACTIONS], { message: '项目状态操作不合法' })
  action!: ProjectStatusAction;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  closeSummary?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  satisfaction?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  retrospective?: string;
}

/* ========== 里程碑 ========== */

export class CreateProjectMilestoneDto implements ICreateProjectMilestoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsDateString()
  planDate?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  weightPct?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class ProjectMilestoneCloseDto implements IProjectMilestoneCloseDto {
  /** 仅允许置为已达成（撤回达成走业务侧状态机，不在本接口） */
  @IsOptional()
  @IsIn(['reached'], { message: '里程碑状态仅支持 reached' })
  status?: 'reached';

  @IsOptional()
  @IsDateString()
  actualDate?: string;

  @IsOptional()
  @IsDateString()
  forecastDate?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  weightPct?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/* ========== 项目变更 ========== */

export class CreateProjectChangeDto implements ICreateProjectChangeDto {
  @IsString()
  @IsIn([...CHANGE_TYPES], { message: '变更类型不合法' })
  changeType!: ICreateProjectChangeDto['changeType'];

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  beforeValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  afterValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  applicant?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/* ========== 交付物 ========== */

export class CreateDeliverableDto implements ICreateDeliverableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn([...DELIVERABLE_TYPES], { message: '交付物类型不合法' })
  deliverableType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  acceptanceCriteria?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  reviewer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class UpdateDeliverableDto implements IUpdateDeliverableDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn([...DELIVERABLE_TYPES], { message: '交付物类型不合法' })
  deliverableType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  acceptanceCriteria?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  reviewer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class AcceptDeliverableDto implements IAcceptDeliverableDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reviewer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  acceptConclusion?: string;
}

/* ========== 项目收入确认 ========== */

export class CreateProjectRevenueDto implements ICreateProjectRevenueDto {
  @IsString()
  @Matches(PERIOD_RE, { message: '期间格式须为 YYYY-MM' })
  period!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: '确认金额必须大于 0' })
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/* ========== 项目周报 / 纪要 ========== */

export class CreateProjectMinutesDto implements ICreateProjectMinutesDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title!: string;

  @IsString()
  @IsIn([...MINUTES_TYPES], { message: '纪要类型不合法' })
  minutesType!: ICreateProjectMinutesDto['minutesType'];

  @IsString()
  @Matches(DATE_RE, { message: '日期格式须为 YYYY-MM-DD' })
  meetingDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  content?: string;
}

/** 交付物验收退回（POST /api/projects/deliverables/:id/return） */
export class ReturnDeliverableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** 变更单审批（POST /api/projects/changes/:id/approve） */
export class ApproveChangeDto {
  @IsString()
  @IsIn(['approve', 'reject'], { message: '审批动作不合法' })
  action!: 'approve' | 'reject';
}
