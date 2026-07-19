import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { fetchPublishedProperties, fetchPropertyBySlug, invalidatePropertyCache } from '../services/wpGraphQL.service';

export const listPropertiesHandler = asyncHandler(async (req: Request, res: Response) => {
  const first = Math.min(Number(req.query.first) || 20, 50);
  const after = typeof req.query.after === 'string' ? req.query.after : undefined;

  const result = await fetchPublishedProperties(first, after);
  res.status(200).json({ success: true, data: result.nodes, pageInfo: result.pageInfo });
});

export const getPropertyBySlugHandler = asyncHandler(async (req: Request, res: Response) => {
  const property = await fetchPropertyBySlug(req.params.slug);
  res.status(200).json({ success: true, data: property });
});

/** Called by a WordPress webhook (save_post hook) when content changes, to bust the cache early. */
export const invalidatePropertyCacheHandler = asyncHandler(async (req: Request, res: Response) => {
  await invalidatePropertyCache(req.body?.slug);
  res.status(200).json({ success: true, message: 'Cache invalidated' });
});
