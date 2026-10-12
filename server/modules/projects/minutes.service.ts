import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { desc, eq } from 'drizzle-orm';
import { erpProject, erpProjectMinutes } from '@server/database/schema';
import { MINUTES_TYPES } from '@shared/api.interface';
import type {
  CreateProjectMinutesDto,
  ProjectMinutes,
} from '@shared/api.interface';

const MEETING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

@Injectable()
export class MinutesService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toMinutes(row: typeof erpProjectMinutes.$inferSelect): ProjectMinutes {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      minutesType: row.minutesType as ProjectMinutes['minutesType'],
      meetingDate: row.meetingDate,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listByProject(projectId: string): Promise<ProjectMinutes[]> {
    const rows = await this.db
      .select()
      .from(erpProjectMinutes)
      .where(eq(erpProjectMinutes.projectId, projectId))
      .orderBy(desc(erpProjectMinutes.meetingDate));
    return rows.map((row) => this.toMinutes(row));
  }

  async create(
    projectId: string,
    dto: CreateProjectMinutesDto
  ): Promise<ProjectMinutes> {
    const projects = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projects.length === 0) throw new NotFoundException('项目不存在');
    if (
      !MINUTES_TYPES.includes(
        dto.minutesType as (typeof MINUTES_TYPES)[number]
      )
    ) {
      throw new BadRequestException(`纪要类型须为 ${MINUTES_TYPES.join('/')}`);
    }
    if (!MEETING_DATE_RE.test(dto.meetingDate)) {
      throw new BadRequestException('日期格式须为 YYYY-MM-DD');
    }
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('标题不能为空');
    if (title.length > 100) {
      throw new BadRequestException('标题不能超过 100 字');
    }
    const content = dto.content?.trim();
    const rows = await this.db
      .insert(erpProjectMinutes)
      .values({
        projectId,
        title,
        minutesType: dto.minutesType,
        meetingDate: dto.meetingDate,
        content: content ? content : null,
      })
      .returning();
    return this.toMinutes(rows[0]);
  }

  async remove(id: string): Promise<void> {
    const rows = await this.db
      .delete(erpProjectMinutes)
      .where(eq(erpProjectMinutes.id, id))
      .returning({ id: erpProjectMinutes.id });
    if (rows.length === 0) throw new NotFoundException('纪要不存在');
  }
}
