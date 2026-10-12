import { Global, Module } from '@nestjs/common';
import { ActorAccessService } from './actor-access.service';

@Global()
@Module({
  providers: [ActorAccessService],
  exports: [ActorAccessService],
})
export class ActorAccessModule {}
