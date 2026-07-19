import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool, withTransaction } from '../config/db';
import { fingerprintEnquiry } from '../utils/hash';
import { ConflictError, NotFoundError } from '../middleware/errorHandler';
import { CreateEnquiryInput } from '../validators/enquiry.validator';
import { enqueueCrmSync } from '../queues/crmSync.queue';
import { enqueueEmail } from '../queues/email.queue';
import { logger } from '../utils/logger';

export interface EnquiryRecord extends RowDataPacket {
  id: number;
  property_id: number;
  full_name: string;
  email: string;
  phone: string | null;
  message: string;
  source: string;
  status: string;
  crm_record_id: string | null;
  created_at: Date;
  property_title?: string;
}

interface CreateEnquiryContext {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Creates a new enquiry.
 *
 * Duplicate prevention strategy (defense in depth, 2 layers):
 *  1. Application-level fingerprint check (fast, gives a clean 409 with a
 *     friendly message before we even attempt a write).
 *  2. Database UNIQUE constraint on `fingerprint` (the real guarantee -
 *     atomic and race-condition-proof even if two identical requests land
 *     on two different app instances in the same millisecond).
 */
export async function createEnquiry(input: CreateEnquiryInput, ctx: CreateEnquiryContext) {
  const fingerprint = fingerprintEnquiry({
    email: input.email,
    phone: input.phone,
    propertyId: input.propertyId,
    message: input.message,
  });

  try {
    const enquiry = await withTransaction(async (conn) => {
      // Verify the referenced property actually exists before creating an
      // enquiry against it, rather than relying solely on the FK error
      // (which would surface as an unfriendly 500 error).
      const [propertyRows] = await conn.query<RowDataPacket[]>(
        'SELECT id FROM properties WHERE id = :id AND status = "published" LIMIT 1',
        { id: input.propertyId }
      );
      if (propertyRows.length === 0) {
        throw new NotFoundError(`Property ${input.propertyId} not found or not published`);
      }

      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO enquiries
          (property_id, full_name, email, phone, message, source, fingerprint, ip_address, user_agent)
         VALUES
          (:propertyId, :fullName, :email, :phone, :message, :source, :fingerprint, :ipAddress, :userAgent)`,
        {
          propertyId: input.propertyId,
          fullName: input.fullName,
          email: input.email,
          phone: input.phone ?? null,
          message: input.message,
          source: input.source,
          fingerprint,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        }
      );

      const [rows] = await conn.query<EnquiryRecord[]>('SELECT * FROM enquiries WHERE id = :id', {
        id: result.insertId,
      });
      return rows[0];
    });

    // Fire-and-forget async workflows - these must NOT block the HTTP
    // response. CRM sync and email sending each have their own retry/backoff
    // policy (see queues/*.queue.ts) so a slow/down third party never slows
    // down enquiry creation itself.
    await enqueueCrmSync({ enquiryId: enquiry.id });
    await enqueueEmail({
      to: enquiry.email,
      template: 'enquiry_confirmation',
      data: { fullName: enquiry.full_name, enquiryId: enquiry.id },
    });

    return enquiry;
  } catch (err: any) {
    // MySQL error 1062 = duplicate entry on a unique index.
    if (err?.errno === 1062 || err?.code === 'ER_DUP_ENTRY') {
      logger.warn('Duplicate enquiry submission blocked', { fingerprint, email: input.email });
      throw new ConflictError('An identical enquiry has already been submitted recently.');
    }
    throw err;
  }
}

export async function getEnquiryById(id: number): Promise<EnquiryRecord> {
  // Single JOIN query - see PERFORMANCE.md "Issue #1: N+1 query on enquiry
  // list" for the anti-pattern this replaces (previously: 1 query for
  // enquiries + N queries for each property name).
  const [rows] = await pool.query<EnquiryRecord[]>(
    `SELECT e.*, p.title AS property_title
     FROM enquiries e
     JOIN properties p ON p.id = e.property_id
     WHERE e.id = :id
     LIMIT 1`,
    { id }
  );

  if (rows.length === 0) throw new NotFoundError(`Enquiry ${id} not found`);
  return rows[0];
}

interface ListEnquiriesParams {
  page: number;
  limit: number;
  status?: string;
  cursor?: number;
}

/**
 * Paginated list.
 *
 * We support BOTH offset pagination (page/limit - simple, fine for the
 * first ~50 pages an admin will actually click through) AND cursor
 * pagination (cursor param - O(1) regardless of depth, fine for infinite
 * scroll / API consumers paging through the entire dataset). See
 * PERFORMANCE.md "Issue #2: OFFSET pagination degrades on large tables"
 * for why cursor pagination exists as an option at all.
 */
export async function listEnquiries(params: ListEnquiriesParams) {
  const { page, limit, status, cursor } = params;

  const whereClauses: string[] = [];
  const values: Record<string, unknown> = { limit };

  if (status) {
    whereClauses.push('e.status = :status');
    values.status = status;
  }

  if (cursor) {
    whereClauses.push('e.id < :cursor');
    values.cursor = cursor;
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Single round trip: fetch page rows + total count together using a
  // window function, instead of two separate queries (COUNT(*) + SELECT).
  const [rows] = await pool.query<EnquiryRecord[]>(
    `SELECT e.*, p.title AS property_title,
            COUNT(*) OVER() AS total_count
     FROM enquiries e
     JOIN properties p ON p.id = e.property_id
     ${whereSql}
     ORDER BY e.id DESC
     LIMIT :limit ${cursor ? '' : 'OFFSET :offset'}`,
    // mysql2's TS types for named-placeholder objects are overly strict
    // (they expect a shape compatible with its internal QueryValues union);
    // at runtime it just accepts a plain key/value object, so we cast here
    // rather than fight the type system on something already validated by
    // Zod before it ever reaches this function.
    (cursor ? values : { ...values, offset: (page - 1) * limit }) as any
  );

  const total = (rows[0] as any)?.total_count ?? 0;
  const data = rows.map(({ total_count, ...rest }: any) => rest);

  return {
    data,
    pagination: cursor
      ? { nextCursor: data.length ? data[data.length - 1].id : null, limit }
      : { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
  };
}

export async function markCrmSynced(enquiryId: number, crmRecordId: string, status?: string) {
  await pool.query(
    `UPDATE enquiries
     SET crm_record_id = :crmRecordId, crm_synced_at = NOW() ${status ? ', status = :status' : ''}
     WHERE id = :enquiryId`,
    { enquiryId, crmRecordId, ...(status ? { status } : {}) }
  );
}
