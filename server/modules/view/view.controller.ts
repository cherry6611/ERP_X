import { Controller, Get, NotFoundException, Render, Req } from '@nestjs/common';
import { Public } from '@server/platform';
import type { Request } from 'express';

@Public()
@Controller()
export class ViewController {

  /**
   * SPA 兜底路由。
   *
   * 本控制器在注册顺序上位于最后，其 `*` 通配会吞掉所有未被业务路由匹配的请求。
   * 此前访问不存在的 `/api/xxx` 会落到这里并被当作页面渲染，抛出 500 且把 hbs
   * 的调用堆栈直接回给调用方（语义错误 + 信息泄露）。这里显式把 /api 前缀剔除，
   * 改为返回标准 JSON 404。
   */
  @Get(['/', '*'])
  @Render('index')
  async render(@Req() req: Request): Promise<{ __platform__: string }>  {
    if (req.path.startsWith('/api')) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `接口不存在: GET ${req.path}`,
      });
    }
    // you can add custom render params here
    const platformData = req.__platform_data__ ?? {};
    const raw: string = JSON.stringify(platformData).replace(/</g, '\\u003c');
    return {
      // don't delete this line, it's used by client to get platform info
      __platform__: raw,
    };
  }
}
