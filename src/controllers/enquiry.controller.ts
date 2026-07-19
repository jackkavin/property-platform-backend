import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import * as enquiryService from '../services/enquiry.service';

export const createEnquiryHandler = asyncHandler(async (req: Request, res: Response) => {
  const enquiry = await enquiryService.createEnquiry(req.body, {
    ipAddress: req.ip || null,
    userAgent: req.header('user-agent') || null,
  });

  res.status(201).json({
    success: true,
    data: {
      id: enquiry.id,
      propertyId: enquiry.property_id,
      fullName: enquiry.full_name,
      email: enquiry.email,
      status: enquiry.status,
      createdAt: enquiry.created_at,
    },
  });
});

export const getEnquiryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as unknown as { id: number };
  const enquiry = await enquiryService.getEnquiryById(id);

  res.status(200).json({
    success: true,
    data: {
      id: enquiry.id,
      propertyId: enquiry.property_id,
      propertyTitle: enquiry.property_title,
      fullName: enquiry.full_name,
      email: enquiry.email,
      phone: enquiry.phone,
      message: enquiry.message,
      status: enquiry.status,
      crmRecordId: enquiry.crm_record_id,
      createdAt: enquiry.created_at,
    },
  });
});

export const listEnquiriesHandler = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page: number; limit: number; status?: string; cursor?: number };
  const result = await enquiryService.listEnquiries(query);

  res.status(200).json({
    success: true,
    data: result.data.map((e: any) => ({
      id: e.id,
      propertyId: e.property_id,
      propertyTitle: e.property_title,
      fullName: e.full_name,
      email: e.email,
      status: e.status,
      createdAt: e.created_at,
    })),
    pagination: result.pagination,
  });
});
