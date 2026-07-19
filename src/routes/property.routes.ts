import { Router } from 'express';
import { listPropertiesHandler, getPropertyBySlugHandler, invalidatePropertyCacheHandler } from '../controllers/property.controller';
import { generalRateLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/properties', generalRateLimiter, listPropertiesHandler);
router.get('/properties/:slug', generalRateLimiter, getPropertyBySlugHandler);
router.post('/properties/cache/invalidate', invalidatePropertyCacheHandler);

export default router;
