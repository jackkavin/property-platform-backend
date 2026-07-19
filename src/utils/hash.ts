import crypto from 'crypto';

/**
 * Deterministic fingerprint of an enquiry payload, used for duplicate
 * detection. We deliberately only hash the fields that define "the same
 * enquiry" (email + phone + property + normalized message) so that two
 * submissions with identical intent are caught even if e.g. a timestamp
 * or user-agent differs.
 */
export function fingerprintEnquiry(input: {
  email: string;
  phone?: string | null;
  propertyId: number;
  message: string;
}): string {
  const normalized = [
    input.email.trim().toLowerCase(),
    (input.phone || '').replace(/\D/g, ''),
    String(input.propertyId),
    input.message.trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('|');

  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Constant-time comparison of two HMAC signatures to avoid timing attacks
 * when verifying inbound CRM webhook signatures.
 */
export function verifyHmacSignature(payload: string, secret: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const signatureBuf = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');

  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
