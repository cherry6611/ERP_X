import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { CanCapability, NeedLogin } from '@server/platform';
import { WikiService } from './wiki.service';
import type { SyncToWikiRequest, SyncToWikiResponse, WikiNodesResponse } from '@shared/api.interface';

export class SyncToWikiDto implements SyncToWikiRequest {
  @IsString()
  @IsNotEmpty()
  fileToken!: string;

  @IsIn(['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'file'])
  fileType!: 'doc' | 'docx' | 'sheet' | 'bitable' | 'mindnote' | 'file';
}

@Controller('api/wiki')
@NeedLogin()
export class WikiController {
  constructor(private readonly wikiService: WikiService) {}

  @Get('space')
  async getSpace(): Promise<{ spaceId: string }> {
    return { spaceId: await this.wikiService.getWikiSpaceId() };
  }

  @Get('nodes')
  async listNodes(
    @Query('parentNodeToken') parentNodeToken?: string,
    @Query('pageToken') pageToken?: string,
  ): Promise<WikiNodesResponse> {
    return this.wikiService.listNodes(parentNodeToken, pageToken);
  }

  @CanCapability('drive_write')
  @Post('sync')
  async syncToWiki(@Body() dto: SyncToWikiDto): Promise<SyncToWikiResponse> {
    return this.wikiService.syncToWiki(dto.fileToken, dto.fileType);
  }
}
