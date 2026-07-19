import { Request, Response } from 'express';
import { asyncHandler, UnauthorizedError } from '../middleware/errorHandler';
import { verifyWebhookSignature, logWebhookEvent, processCrmWebhook } from '../services/crm.service';
import { webhookEventsTotal } from '../config/metrics';

export const crmWebhookHandler = asyncHandler(async (req: Request, res: Response) => {
  const rawBody: string = (req as any).rawBody || JSON.stringify(req.body);
  const signature = req.header('x-crm-signature');
  const signatureValid = verifyWebhookSignature(rawBody, signature);

  webhookEventsTotal.inc({ signature_valid: String(signatureValid) });

  // Always audit-log the raw event first, valid or not - see crm.service.ts
  // logWebhookEvent doc comment for why this ordering matters.
  await logWebhookEvent(
    {
      enquiryId: req.body?.enquiryId ?? null,
      eventType: req.body?.event ?? 'unknown',
      signatureValid,
      rawPayload: req.body,
      ipAddress: req.ip || null,
    },
    signatureValid ? 'received' : 'rejected',
    signatureValid ? undefined : 'Invalid or missing HMAC signature'
  );

  if (!signatureValid) {
    throw new UnauthorizedError('Invalid webhook signature');
  }

  await processCrmWebhook({
    enquiryId: req.body.enquiryId,
    crmRecordId: req.body.crmRecordId,
    status: req.body.status,
  });

  res.status(200).json({ success: true, message: 'Webhook processed' });
});
