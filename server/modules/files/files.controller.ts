import { createReadStream } from 'node:fs';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } })
  )
  async upload(
    @Req() req: Request,
    @UploadedFile()
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer }
  ) {
    const userId = req.userContext?.userId ?? '';
    const saved = await this.files.save(file, userId);
    return { data: saved };
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
    // 强制附件下载，降低 inline XSS 面
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(row.fileName)}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(row.storagePath).pipe(res);
  }
}
