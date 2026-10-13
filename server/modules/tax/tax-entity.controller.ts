import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
import {
  TaxEntityService,
  type TaxEntityInput,
  type TaxEntityItem,
} from './tax-entity.service';

@NeedLogin()
@Controller('api/master-data/tax-entities')
export class TaxEntityController {
  constructor(private readonly taxEntities: TaxEntityService) {}

  @Get()
  async list(): Promise<TaxEntityItem[]> {
    return this.taxEntities.list();
  }

  @CanRole(['admin'])
  @Post()
  async create(@Body() dto: TaxEntityInput): Promise<TaxEntityItem> {
    return this.taxEntities.create(dto);
  }

  @CanRole(['admin'])
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<TaxEntityInput>
  ): Promise<TaxEntityItem> {
    return this.taxEntities.update(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/set-default')
  async setDefault(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<TaxEntityItem> {
    return this.taxEntities.setDefault(id);
  }

  @CanRole(['admin'])
  @Post(':id/toggle-status')
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<TaxEntityItem> {
    return this.taxEntities.toggleStatus(id);
  }
}
