import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '@server/platform';
import { CanCapability } from '@server/modules/integrations/integration-authz';
import { actorFromRequest } from '@server/common/auth/actor';
import { TasksService } from './tasks.service';
import type {
  PagedResult,
  TaskBizType,
  TaskItem,
  TaskSummary,
  TaskUrgency,
} from '@shared/api.interface';

/**
 * C-08 待办中心与消息聚合。
 * 读能力用 @CanCapability('dashboard')：所有登录用户都有 dashboard 能力（默认 r），
 * 与"待办是每个登录用户的个人视图"语义一致；
 * 具体可见范围在 service 内按能力矩阵裁剪（见 TasksService 注释）。
 */
@NeedLogin()
@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /** 聚合待办：并行查询各模块"待我处理"，统一模型返回，支持按类型/紧急度排序 */
  @CanCapability('dashboard')
  @Get('my')
  async listMy(
    @Req() req: Request,
    @Query('bizType') bizType?: string,
    @Query('urgency') urgency?: string,
    @Query('sortBy') sortBy?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<TaskItem>> {
    const actor = actorFromRequest(req);
    return this.tasksService.listMy(
      {
        bizType: (bizType as TaskBizType) || undefined,
        urgency: (urgency as TaskUrgency) || undefined,
        sortBy: (sortBy as 'urgency' | 'dueAt' | 'bizType') || 'urgency',
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
      },
      {
        userId: actor.userId,
        userName: actor.userName,
        roles: req.userContext?.roles ?? [],
      }
    );
  }

  /** 角标数量：与列表口径完全一致（total 与 /api/tasks/my 的 total 相同） */
  @CanCapability('dashboard')
  @Get('summary')
  async summary(@Req() req: Request): Promise<TaskSummary> {
    const actor = actorFromRequest(req);
    return this.tasksService.summary({
      userId: actor.userId,
      userName: actor.userName,
      roles: req.userContext?.roles ?? [],
    });
  }
}
