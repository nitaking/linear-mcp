import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { SSEManager } from '../services/sse-manager';
import { LinearService } from '../services/linear-service';
import { McpNotification } from '../types/mcp';
import { ApiError } from '../middleware/error-handler';
import { metrics } from '../utils/metrics';
import { logger } from '../utils/logger';

export function createWebhookHandler(sseManager: SSEManager, _linearService: LinearService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const signature = req.headers['linear-signature'] as string;
      const webhookSecret = process.env.WEBHOOK_SECRET;

      if (webhookSecret) {
        if (!signature) {
          throw new ApiError(401, 'Missing webhook signature');
        }
        const payload = JSON.stringify(req.body);
        const expectedSignature = crypto
          .createHmac('sha256', webhookSecret)
          .update(payload)
          .digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
          throw new ApiError(401, 'Invalid webhook signature');
        }
      }

      const { action, type, data, updatedFrom } = req.body;

      logger.info({ action, type, dataId: data?.id }, 'Webhook received');

      const notification: McpNotification = {
        type: 'mcp.notification',
        method: 'linear.webhook',
        params: {
          entityType: type.toLowerCase() as any,
          entityId: data?.id || 'unknown',
          action: action.toLowerCase() as any,
          data: {
            ...data,
            updatedFrom,
          },
          timestamp: new Date().toISOString(),
        },
      };

      sseManager.broadcast(notification);

      metrics.webhookEvents.inc({ 
        entity_type: notification.params.entityType, 
        action: notification.params.action 
      });

      res.status(200).json({ received: true });

    } catch (error) {
      next(error);
    }
  };
}