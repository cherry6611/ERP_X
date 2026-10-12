import { Controller, Get, Render, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller()
export class ViewController {

  @Get(['/', '*'])
  @Render('index')
  async render(@Req() req: Request): Promise<{ __platform__: string }>  {
    // you can add custom render params here
    const platformData = req.__platform_data__ ?? {};
    const raw: string = JSON.stringify(platformData).replace(/</g, '\\u003c');
    return {
      // don't delete this line, it's used by client to get platform info
      __platform__: raw,
    };
  }
}
