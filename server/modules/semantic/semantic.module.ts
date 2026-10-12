import { Module } from '@nestjs/common';
import { SemanticController } from './semantic.controller';
import { SemanticService } from './semantic.service';

@Module({
  controllers: [SemanticController],
  providers: [SemanticService],
})
export class SemanticModule {}
