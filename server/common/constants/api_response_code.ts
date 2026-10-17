import { HttpStatus } from '@nestjs/common';

// 业务状态码与HTTP状态码的映射
export enum ResponseCode {
  // 成功状态
  SUCCESS = 'SUCCESS',
  CREATED = 'CREATED',
  ACCEPTED = 'ACCEPTED',
  NO_CONTENT = 'NO_CONTENT',

  // 客户端错误
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CONFLICT = 'CONFLICT',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',

  // 服务端错误
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_GATEWAY = 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // 业务错误
  BUSINESS_ERROR = 'BUSINESS_ERROR',
}

// 状态码映射配置
export const RESPONSE_CODE_TO_HTTP_STATUS_MAP: Record<ResponseCode, number> = {
  [ResponseCode.SUCCESS]: HttpStatus.OK,
  [ResponseCode.CREATED]: HttpStatus.CREATED,
  [ResponseCode.ACCEPTED]: HttpStatus.ACCEPTED,
  [ResponseCode.NO_CONTENT]: HttpStatus.NO_CONTENT,

  [ResponseCode.BAD_REQUEST]: HttpStatus.BAD_REQUEST,
  [ResponseCode.UNAUTHORIZED]: HttpStatus.UNAUTHORIZED,
  [ResponseCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ResponseCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ResponseCode.VALIDATION_ERROR]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ResponseCode.CONFLICT]: HttpStatus.CONFLICT,
  [ResponseCode.TOO_MANY_REQUESTS]: HttpStatus.TOO_MANY_REQUESTS,

  [ResponseCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ResponseCode.BAD_GATEWAY]: HttpStatus.BAD_GATEWAY,
  [ResponseCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,

  [ResponseCode.BUSINESS_ERROR]: HttpStatus.UNPROCESSABLE_ENTITY, // 通用业务错误状态码
};

/**
 * HTTP 状态码 → 响应码的**显式反向映射**。
 *
 * ## §6.10 (9)：为什么不能用 `Object.fromEntries` 反转上面那张表
 *
 * 多对一是真实存在的：`VALIDATION_ERROR` 与 `BUSINESS_ERROR` **都是 422**。
 * 反转时后写入的键会覆盖先写入的，于是所有 422 响应都被标成 `BUSINESS_ERROR`
 * —— 客户端据此**无法区分**"参数校验失败（可提示用户改输入）"与
 * "业务规则拒绝（要改的是业务数据）"，只能靠读中文文案猜。
 *
 * 更隐蔽的是：谁覆盖谁**取决于枚举成员的声明顺序**。往枚举里加一个新成员、
 * 或调整两行的位置，就会静默改变所有 422 的响应码语义 —— 没有测试会红。
 *
 * 因此这里手写一张显式表，把"哪个 HTTP 状态对应哪个响应码"钉死在代码里：
 *   · 422 明确映射为 `VALIDATION_ERROR`（Nest 的 ValidationPipe 用的就是 422，
 *     这是最高频的 422 来源，应当拿到最具体的码）；
 *   · `BUSINESS_ERROR` 不再出现在反向表里 —— 它由 `BusinessException`
 *     显式携带（`exception.code`），不需要靠 HTTP 状态反推。
 */
export const HTTP_STATUS_TO_RESPONSE_CODE_MAP: Record<number, ResponseCode> = {
  [HttpStatus.OK]: ResponseCode.SUCCESS,
  [HttpStatus.CREATED]: ResponseCode.CREATED,
  [HttpStatus.ACCEPTED]: ResponseCode.ACCEPTED,
  [HttpStatus.NO_CONTENT]: ResponseCode.NO_CONTENT,

  [HttpStatus.BAD_REQUEST]: ResponseCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ResponseCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ResponseCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ResponseCode.NOT_FOUND,
  // 422 只对应 VALIDATION_ERROR（见上方说明：多对一时必须显式指定）
  [HttpStatus.UNPROCESSABLE_ENTITY]: ResponseCode.VALIDATION_ERROR,
  [HttpStatus.CONFLICT]: ResponseCode.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ResponseCode.TOO_MANY_REQUESTS,

  [HttpStatus.INTERNAL_SERVER_ERROR]: ResponseCode.INTERNAL_ERROR,
  [HttpStatus.BAD_GATEWAY]: ResponseCode.BAD_GATEWAY,
  [HttpStatus.SERVICE_UNAVAILABLE]: ResponseCode.SERVICE_UNAVAILABLE,
};
