import mysql from 'mysql2/promise';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * A single shared connection pool for the whole process.
 * Using a pool (instead of opening a new connection per request) avoids
 * the classic "too many connections" failure under load and lets MySQL
 * reuse TCP + auth handshakes.
 */
export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  namedPlaceholders: true,
  dateStrings: false,
  timezone: 'Z',
  charset: 'utf8mb4_general_ci',
});

export async function verifyDbConnection(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    logger.info('MySQL connection pool verified');
  } finally {
    conn.release();
  }
}

/**
 * Run a callback inside a transaction. Ensures COMMIT/ROLLBACK and
 * connection release always happen, even on thrown errors.
 */
export async function withTransaction<T>(
  fn: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
