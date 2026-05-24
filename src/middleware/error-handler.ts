import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { JsonRpcErrorCodes } from '../types/json-rpc';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public jsonRpcCode?: number,
    public data?: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorHandler(
  err: Error | ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error({
    err,
    req: {
      method: req.method,
      url: req.url,
    },
  }, 'Request error');

  if (err instanceof ApiError) {
    if (req.path === '/rpc') {
      res.status(200).json({
        jsonrpc: '2.0',
        error: {
          code: err.jsonRpcCode || JsonRpcErrorCodes.INTERNAL_ERROR,
          message: err.message,
          data: err.data,
        },
        id: req.body?.id || null,
      });
    } else {
      res.status(err.statusCode).json({
        error: err.message,
        data: err.data,
      });
    }
  } else {
    if (req.path === '/rpc') {
      res.status(200).json({
        jsonrpc: '2.0',
        error: {
          code: JsonRpcErrorCodes.INTERNAL_ERROR,
          message: 'Internal server error',
        },
        id: req.body?.id || null,
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
      });
    }
  }
}