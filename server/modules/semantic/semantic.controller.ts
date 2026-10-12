import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { NeedLogin } from '@server/platform';
import { SemanticService } from './semantic.service';
import type { SemanticBizType, SemanticSimilarResponse } from '@shared/api.interface';

const BIZ_TYPES: string[] = ['contract', 'project'];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

@NeedLogin()
@Controller('api/semantic')
export class SemanticController {
  constructor(private readonly semanticService: SemanticService) {}

  @Get('similar')
  async findSimilar(
    @Query('type') type: string,
    @Query('id') id: string,
    @Query('limit') limit?: string
  ): Promise<SemanticSimilarResponse> {
    if (!BIZ_TYPES.includes(type)) {
      throw new BadRequestException('type 仅支持 contract / project');
    }
    if (!id) {
      throw new BadRequestException('id 不能为空');
    }
    const parsedLimit: number =
      limit === undefined ? DEFAULT_LIMIT : Number.parseInt(limit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
      throw new BadRequestException(`limit 需在 1-${MAX_LIMIT} 之间`);
    }
    const items = await this.semanticService.findSimilar(
      type as SemanticBizType,
      id,
      parsedLimit
    );
    return { items };
  }
}
