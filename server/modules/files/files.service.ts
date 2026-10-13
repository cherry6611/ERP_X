import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { compStoredFile } from '@server/database/schema';
import { assertLocalUploadFile } from '@server/common/security/upload-policy';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

@Injectable()
export class FilesService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async save(
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    ownerUserId: string
  ) {
    assertLocalUploadFile(file);
    const dir = process.env.UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
    await mkdir(dir, { recursive: true });
    const [row] = await this.db
      .insert(compStoredFile)
      .values({
        fileName: file.originalname,
        mime: file.mimetype,
        size: file.size,
        storagePath: 'pending',
        ownerUserId,
      })
      .returning();
    const storagePath = join(dir, row.id);
    await writeFile(storagePath, file.buffer);
    await this.db
      .update(compStoredFile)
      .set({ storagePath })
      .where(eq(compStoredFile.id, row.id));
    return {
      id: row.id,
      file_path: row.id,
      bucket_id: 'local',
      download_url: `/api/files/${row.id}`,
    };
  }

  async open(id: string, userId: string, roles: string[] = []) {
    const rows = await this.db
      .select()
      .from(compStoredFile)
      .where(eq(compStoredFile.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('文件不存在');
    const isAdmin = roles.includes('admin');
    const isOwner = row.ownerUserId != null && row.ownerUserId === userId;
    // 历史无归属文件仅 admin 可下；新文件需本人或 admin
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException('无权下载该文件');
    }
    return row;
  }
}
