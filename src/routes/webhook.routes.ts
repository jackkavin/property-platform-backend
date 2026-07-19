import { Router } from 'express';
import { crmWebhookHandler } from '../controllers/webhook.controller';
import { validate, crmWebhookSchema } from '../validators/enquiry.validator';
import { webhookRateLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/webhook/crm', webhookRateLimiter, validate(crmWebhookSchema, 'body'), crmWebhookHandler);

export default router;
