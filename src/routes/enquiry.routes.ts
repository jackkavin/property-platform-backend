import { Router } from 'express';
import { createEnquiryHandler, getEnquiryHandler, listEnquiriesHandler } from '../controllers/enquiry.controller';
import { validate, createEnquirySchema, enquiryIdParamSchema, listEnquiriesQuerySchema } from '../validators/enquiry.validator';
import { enquiryRateLimiter } from '../middleware/rateLimiter';
import { idempotencyMiddleware } from '../middleware/idempotency';

const router = Router();

router.post(
  '/enquiry',
  enquiryRateLimiter,
  idempotencyMiddleware(),
  validate(createEnquirySchema, 'body'),
  createEnquiryHandler
);

router.get('/enquiry/:id', validate(enquiryIdParamSchema, 'params'), getEnquiryHandler);

router.get('/enquiries', validate(listEnquiriesQuerySchema, 'query'), listEnquiriesHandler);

export default router;
