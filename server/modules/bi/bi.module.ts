import { Module } from '@nestjs/common';
import { ProjectsModule } from '@server/modules/projects/projects.module';
import { BiController } from './bi.controller';
import { BiService } from './bi.service';

@Module({
  imports: [ProjectsModule],
  controllers: [BiController],
  providers: [BiService],
})
export class BiModule {}
