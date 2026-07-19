import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../middleware/errorHandler';

/**
 * Vulnerability this fixes: SQL Injection / malformed-input crashes via weak
 * or missing validation (SECURITY_REPORT.md, VULN-06, and Threat Scenario 5).
 * All input is strictly typed and bounded *before* it ever reaches a query.
 * Combined with parameterized queries (see services/*.service.ts), this
 * gives defense in depth: even if one layer were bypassed, the other holds.
 */
export const createEnquirySchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+()\-\s]{6,20}$/, 'Invalid phone number format')
    .optional()
    .nullable(),
  propertyId: z.coerce.number().int().positive(),
  message: z.string().trim().min(1).max(2000),
  source: z.enum(['website', 'mobile_app', 'partner_portal', 'other']).default('website'),
});
export type CreateEnquiryInput = z.infer<typeof createEnquirySchema>;

export const enquiryIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listEnquiriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped hard at 100 to prevent a client requesting an unbounded page
  // size that would force a huge, memory-heavy result set (see PERFORMANCE.md).
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['new', 'contacted', 'converted', 'closed']).optional(),
  cursor: z.coerce.number().int().positive().optional(),
});

export const crmWebhookSchema = z.object({
  event: z.enum(['lead.updated', 'lead.status_changed', 'contact.synced']),
  enquiryId: z.coerce.number().int().positive(),
  crmRecordId: z.string().trim().min(1).max(100),
  status: z.enum(['new', 'contacted', 'converted', 'closed']).optional(),
  payload: z.record(z.unknown()).optional(),
});

type Schema = z.ZodTypeAny;

/** Generic middleware factory: validates & replaces req.body/query/params against a zod schema. */
export function validate(schema: Schema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      throw new ValidationError('Request validation failed', result.error.flatten().fieldErrors);
    }
    (req as any)[source] = result.data;
    next();
  };
}
