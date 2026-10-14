import { createReadStream } from 'node:fs';
import { Body, Controller, Get, Post, Put, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { Request, Response } from 'express';
import { CanCapability, NeedLogin, Public } from '@server/platform';
import { FilesService } from '@server/modules/files/files.service';
import { SettingsService } from './settings.service';

class UpdateBrandDto {
  @IsOptional()
  @IsString()
  brandName?: string;

  @IsOptional()
  @IsUUID()
  logoFileId?: string | null;

  @IsOptional()
  @IsUUID()
  faviconFileId?: string | null;
}

class UpsertQuotationBitableDto {
  @IsString()
  appToken!: string;

  @IsString()
  tableId!: string;

  @IsOptional()
  fieldMap?: Record<string, string>;

  @IsOptional()
  enabled?: boolean;
}

@NeedLogin()
@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly files: FilesService,
  ) {}

  @Public()
  @Get('brand')
  getBrand() {
    return this.settings.getBrand();
  }

  /** 登录页匿名可读品牌 Logo（仅当前配置文件） */
  @Public()
  @Get('brand/logo')
  async brandLogo(@Res() res: Response): Promise<void> {
    const file = await this.settings.getLogoFile();
    if (!file) {
      res.status(404).json({ message: '未配置 Logo' });
      return;
    }
    res.setHeader('Content-Type', file.mime || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    createReadStream(file.storagePath).pipe(res);
  }

  @NeedLogin()
  @CanCapability('settings_brand')
  @Put('brand')
  updateBrand(@Req() req: Request, @Body() dto: UpdateBrandDto) {
    return this.settings.updateBrand(req.userContext?.userId ?? '', dto);
  }

  @NeedLogin()
  @CanCapability('settings_brand')
  @Post('brand/logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1 * 1024 * 1024 } }))
  async uploadLogo(
    @Req() req: Request,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
    if (!file || !allowed.includes(file.mimetype)) {
      return { error: '仅支持 PNG / JPEG / WebP / SVG，且不超过 1MB' };
    }
    const saved = await this.files.save(file, req.userContext?.userId ?? '');
    const brand = await this.settings.updateBrand(req.userContext?.userId ?? '', {
      logoFileId: saved.id,
    });
    return { data: saved, brand };
  }

  @NeedLogin()
  @CanCapability('settings_appearance')
  @Get('feishu-bitable/quotation')
  getQuotationBitable() {
    return this.settings.getQuotationBitableConfig();
  }

  @NeedLogin()
  @CanCapability('settings_feishu')
  @Put('feishu-bitable/quotation')
  upsertQuotationBitable(@Body() dto: UpsertQuotationBitableDto) {
    return this.settings.upsertQuotationBitableConfig(dto);
  }
}
