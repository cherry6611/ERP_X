import { createReadStream } from 'node:fs';
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { NeedLogin } from '@server/platform';
import { FilesService } from './files.service';

@NeedLogin()
@Controller('api/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * B-06 ②：上传。带 `parentFileId` 时创建新版本（同一版本链只保留一个 is_latest）。
   * 响应回传 `version / scanStatus / scanDetail`，前端需展示"未扫描/扫描失败"提示。
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } })
  )
  async upload(
    @Req() req: Request,
    @UploadedFile()
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    @Query('parentFileId') parentFileId?: string
  ) {
    const userId = req.userContext?.userId ?? '';
    if (parentFileId !== undefined && parentFileId !== '') {
      // 早期写法不满足 UUID 时会落到数据库报错（500），这里显式 400
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentFileId)) {
        throw new BadRequestException('parentFileId 必须为 UUID');
      }
    }
    const saved = await this.files.save(file, userId, {
      parentFileId: parentFileId || undefined,
    });
    return { data: saved };
  }

  /** B-06 ②：版本链（默认最新在前） */
  @Get(':id/versions')
  async versions(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    const userId = req.userContext?.userId ?? '';
    const roles = req.userContext?.roles ?? [];
    return {
      items: await this.files.listVersions(id, userId, roles),
    };
  }

  @Get(':id')
  async download(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response
  ): Promise<void> {
    const userId = req.userContext?.userId ?? '';
    const roles = req.userContext?.roles ?? [];
    const row = await this.files.open(id, userId, roles);
    // 强制附件下载，降低 inline XSS 面。
    // SVG 即使带 attachment 在部分浏览器仍可内联渲染脚本，故降级为纯文本类型。
    const isSvg = (row.mime ?? '').toLowerCase().includes('svg');
    res.setHeader(
      'Content-Type',
      isSvg ? 'text/plain; charset=utf-8' : row.mime || 'application/octet-stream'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(row.fileName)}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const stream = createReadStream(row.storagePath);
    stream.on('error', (err: Error) => {
      if (!res.headersSent) {
        res.status(500).json({ message: '文件读取失败' });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  }
}
