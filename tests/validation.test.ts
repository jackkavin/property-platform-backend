import { createEnquirySchema } from '../src/validators/enquiry.validator';
import { fingerprintEnquiry, verifyHmacSignature } from '../src/utils/hash';
import crypto from 'crypto';

describe('createEnquirySchema', () => {
  it('accepts a valid enquiry payload', () => {
    const result = createEnquirySchema.safeParse({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+919876543210',
      propertyId: 1,
      message: 'Interested in a viewing',
      source: 'website',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email', () => {
    const result = createEnquirySchema.safeParse({
      fullName: 'Jane Doe',
      email: 'not-an-email',
      propertyId: 1,
      message: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive propertyId', () => {
    const result = createEnquirySchema.safeParse({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      propertyId: -1,
      message: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = createEnquirySchema.safeParse({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      propertyId: 1,
      message: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a message over 2000 characters', () => {
    const result = createEnquirySchema.safeParse({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      propertyId: 1,
      message: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('fingerprintEnquiry', () => {
  it('produces the same fingerprint for equivalent input with different casing/whitespace', () => {
    const a = fingerprintEnquiry({ email: 'Jane@Example.com', phone: '+91 98765 43210', propertyId: 1, message: 'Hello there' });
    const b = fingerprintEnquiry({ email: 'jane@example.com', phone: '919876543210', propertyId: 1, message: 'hello   there' });
    expect(a).toBe(b);
  });

  it('produces a different fingerprint for a different property', () => {
    const a = fingerprintEnquiry({ email: 'jane@example.com', phone: null, propertyId: 1, message: 'Hello' });
    const b = fingerprintEnquiry({ email: 'jane@example.com', phone: null, propertyId: 2, message: 'Hello' });
    expect(a).not.toBe(b);
  });
});

describe('verifyHmacSignature', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a correctly computed signature', () => {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyHmacSignature(body, secret, `sha256=${sig}`)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyHmacSignature(JSON.stringify({ hello: 'world!' }), secret, `sha256=${sig}`)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    expect(verifyHmacSignature(body, secret, `sha256=${sig}`)).toBe(false);
  });
});
