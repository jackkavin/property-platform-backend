import { pool } from '../config/db';
import { verifyHmacSignature } from '../utils/hash';
import { env } from '../config/env';
import { NotFoundError } from '../middleware/errorHandler';
import { markCrmSynced } from './enquiry.service';
import { logger } from '../utils/logger';

interface WebhookAuditInput {
  enquiryId: number | null;
  eventType: string;
  signatureValid: boolean;
  rawPayload: unknown;
  ipAddress: string | null;
}

/**
 * Every inbound webhook call is logged BEFORE we decide whether to trust or
 * process it. This is deliberate: if an attacker sends a forged/malicious
 * payload (Threat Scenario 2), we still have a full record for incident
 * response - the audit trail must not depend on the payload being valid.
 */
export async function logWebhookEvent(input: WebhookAuditInput, status: 'received' | 'processed' | 'failed' | 'rejected', errorMessage?: string) {
  await pool.query(
    `INSERT INTO crm_webhook_events (enquiry_id, event_type, signature_valid, raw_payload, processing_status, error_message, ip_address)
     VALUES (:enquiryId, :eventType, :signatureValid, CAST(:rawPayload AS JSON), :status, :errorMessage, :ipAddress)`,
    {
      enquiryId: input.enquiryId,
      eventType: input.eventType,
      signatureValid: input.signatureValid ? 1 : 0,
      rawPayload: JSON.stringify(input.rawPayload).slice(0, 60000), // guard against pathological payload size
      status,
      errorMessage: errorMessage ?? null,
      ipAddress: input.ipAddress,
    }
  );
}

/**
 * Vulnerability this fixes: unauthenticated / unverified webhook endpoint
 * allowing anyone to POST fabricated CRM events (SECURITY_REPORT.md,
 * VULN-03 and Threat Scenario 2).
 *
 * The CRM must sign every request body with HMAC-SHA256 using a shared
 * secret, sent as `X-CRM-Signature: sha256=<hex>`. We recompute the
 * signature over the raw body and reject anything that doesn't match -
 * this is what makes the endpoint trustworthy despite being internet-facing.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  return verifyHmacSignature(rawBody, env.CRM_WEBHOOK_SECRET, signatureHeader);
}

interface ProcessWebhookInput {
  enquiryId: number;
  crmRecordId: string;
  status?: string;
}

export async function processCrmWebhook(input: ProcessWebhookInput) {
  const [rows] = await pool.query('SELECT id FROM enquiries WHERE id = :id', { id: input.enquiryId });
  if ((rows as any[]).length === 0) {
    throw new NotFoundError(`Enquiry ${input.enquiryId} not found - cannot apply CRM update`);
  }

  await markCrmSynced(input.enquiryId, input.crmRecordId, input.status);
  logger.info('CRM webhook applied', { enquiryId: input.enquiryId, crmRecordId: input.crmRecordId });
}

/**
 * Simulates the outbound side: pushing a newly created enquiry TO the CRM.
 * In production this would call the real CRM's REST/SOAP API. It's called
 * from the async worker (queues/crmSync.worker.ts), never inline on the
 * request path, so a slow or unavailable CRM never delays the user's
 * enquiry submission response.
 */
export async function pushEnquiryToCrm(enquiryId: number): Promise<{ crmRecordId: string }> {
  // Simulated network call with artificial latency + occasional failure,
  // to exercise the queue's retry/backoff behaviour realistically.
  await new Promise((resolve) => setTimeout(resolve, 150));

  if (Math.random() < 0.1) {
    throw new Error('Simulated CRM upstream timeout');
  }

  const crmRecordId = `crm_${enquiryId}_${Date.now()}`;
  await markCrmSynced(enquiryId, crmRecordId);
  return { crmRecordId };
}
