import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { CanCapability, CanCapabilityRead, NeedLogin } from '@server/platform';
import { DriveEditor } from '@server/common/auth/read-roles';
import { consumeRate } from '@server/common/security/rate-limit';
import { actorFromRequest } from '@server/common/auth/actor';
import { DriveService } from './drive.service';
import { DriveConfigService } from './drive-config.service';
import { FeishuClientService } from './feishu-client.service';
import type {
  CreateDocumentRequest,
  CreateFolderRequest,
  DeleteFileResponse,
  DriveCreatedItem,
  DriveFolderChildrenResponse,
  FeishuDriveConfigResponse,
  RenameFileRequest,
  UpdateFeishuDriveConfigRequest,
  UploadFileRequest,
} from '@shared/api.interface';

export class CreateFolderDto implements CreateFolderRequest {
  @IsString()
  @IsNotEmpty()
  parentToken!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class CreateDocumentDto implements CreateDocumentRequest {
  @IsString()
  @IsNotEmpty()
  folderToken!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;
}

export class UploadFileDto implements UploadFileRequest {
  @IsString()
  @IsNotEmpty()
  folderToken!: string;

  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  base64Content!: string;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  size!: number;
}

export class RenameFileDto implements RenameFileRequest {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class UpdateDriveConfigDto implements UpdateFeishuDriveConfigRequest {
  @IsOptional()
  @IsString()
  appId?: string;

  @IsOptional()
  @IsString()
  appSecret?: string;

  @IsOptional()
  @IsString()
  rootFolderToken?: string;

  @IsOptional()
  @IsString()
  wikiSpaceId?: string;
}

@Controller('api/drive')
@NeedLogin()
export class DriveController {
  constructor(
    private readonly driveService: DriveService,
    private readonly configService: DriveConfigService,
    private readonly feishuClient: FeishuClientService,
  ) {}

  @Get('root')
  async getRoot(): Promise<{ folderToken: string }> {
    return { folderToken: await this.driveService.getRootFolderToken() };
  }

  @Get('folders/:folderToken/children')
  async listChildren(
    @Param('folderToken') folderToken: string,
    @Query('pageToken') pageToken?: string,
  ): Promise<DriveFolderChildrenResponse> {
    return this.driveService.listChildren(folderToken, pageToken);
  }

  @DriveEditor()
  @Post('folders')
  async createFolder(
    @Body() dto: CreateFolderDto,
  ): Promise<DriveCreatedItem> {
    return this.driveService.createFolder(dto.parentToken, dto.name);
  }

  @DriveEditor()
  @Post('documents')
  async createDocument(
    @Body() dto: CreateDocumentDto,
  ): Promise<DriveCreatedItem> {
    return this.driveService.createDocument(dto.folderToken, dto.title);
  }

  @DriveEditor()
  @Post('files/upload')
  async uploadFile(
    @Req() req: Request,
    @Body() dto: UploadFileDto,
  ): Promise<DriveCreatedItem> {
    const actor = actorFromRequest(req);
    await consumeRate(`drive-upload:${actor.userId}`, 20, 60 * 60 * 1000);
    return this.driveService.uploadFile(
      dto.folderToken,
      dto.fileName,
      dto.base64Content,
      dto.size,
    );
  }

  @CanCapability('drive_write')
  @Patch('files/:fileToken')
  async renameFile(
    @Param('fileToken') fileToken: string,
    @Query('type') type: string,
    @Body() dto: RenameFileDto,
  ): Promise<DriveCreatedItem> {
    return this.driveService.renameFile(fileToken, type, dto.name);
  }

  @CanCapability('drive_write')
  @Delete('files/:fileToken')
  async deleteFile(
    @Param('fileToken') fileToken: string,
    @Query('type') type: string,
  ): Promise<DeleteFileResponse> {
    await this.driveService.deleteFile(fileToken, type);
    return { token: fileToken, deleted: true };
  }

  @CanCapabilityRead('drive')
  @Get('files/:fileToken/members')
  async listMembers(
    @Param('fileToken') fileToken: string,
    @Query('type') type: string,
  ): Promise<unknown> {
    return this.driveService.listPermissionMembers(fileToken, type || 'docx');
  }

  @CanCapability('drive')
  @Get('config')
  async getConfig(): Promise<FeishuDriveConfigResponse> {
    return this.configService.getConfigForAdmin();
  }

  @CanCapability('drive_write')
  @Put('config')
  async updateConfig(
    @Req() req: Request,
    @Body() dto: UpdateDriveConfigDto,
  ): Promise<FeishuDriveConfigResponse> {
    await this.configService.updateConfig(dto, req.userContext?.userId ?? '');
    this.feishuClient.invalidateToken();
    return this.configService.getConfigForAdmin();
  }
}
