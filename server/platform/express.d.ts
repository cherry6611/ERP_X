declare global {
  namespace Express {
    interface Request {
      __platform_data__?: Record<string, unknown>;
      userContext: {
        userId?: string;
        userName?: string;
        roles?: string[];
        tenantId?: number;
      };
    }
  }
}

export {};
