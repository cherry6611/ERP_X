import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { TaxEntityService, type TaxEntityItem } from './tax-entity.service';
import { CreateTaxEntityDto, UpdateTaxEntityDto } from './tax-entity.dto';

@NeedLogin()
@Controller('api/master-data/tax-entities')
export class TaxEntityController {
  constructor(private readonly taxEntities: TaxEntityService) {}

  @Get()
  async list(): Promise<TaxEntityItem[]> {
    return this.taxEntities.list();
  }

  @CanCapability('tax_entity')
  @Post()
  async create(@Body() dto: CreateTaxEntityDto): Promise<TaxEntityItem> {
    return this.taxEntities.create(dto);
  }

  @CanCapability('tax_entity')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxEntityDto
  ): Promise<TaxEntityItem> {
    return this.taxEntities.update(id, dto);
  }

  @CanCapability('tax_entity')
  @Post(':id/set-default')
  async setDefault(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<TaxEntityItem> {
    return this.taxEntities.setDefault(id);
  }

  @CanCapability('tax_entity')
  @Post(':id/toggle-status')
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<TaxEntityItem> {
    return this.taxEntities.toggleStatus(id);
  }
}
