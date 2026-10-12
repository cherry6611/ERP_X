import { Module } from '@nestjs/common';
import { PurController } from './pur.controller';
import { PurService } from './pur.service';

@Module({
  controllers: [PurController],
  providers: [PurService],
})
export class PurModule {}
