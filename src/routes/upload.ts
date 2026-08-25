import { Router, Request, Response } from 'express';
import multer from 'multer';
import { uploadMultipleToCloudinary } from '../cloudinary';
import { requireAdmin } from './settings';

const router = Router();

// Store file in memory so we can stream it directly to Cloudinary
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
    files: 10,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

/**
 * POST /api/upload
 * Accepts one or more image files under the field name "images".
 * Also supports legacy single field "image".
 * Requires admin authentication.
 * Returns: { imageUrl: string, imageUrls: string[] }
 */
router.post(
  '/',
  async (req: Request, res: Response) => {
    // Admin check before processing the file
    if (!(await requireAdmin(req, res))) return;

    // Run multer manually so we can handle its errors cleanly
    upload.fields([{ name: 'images', maxCount: 10 }, { name: 'image', maxCount: 1 }])(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Image must be 5 MB or smaller' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Unexpected file field. Use "images" or "image".' });
        }
        return res.status(400).json({ error: err.message });
      }

      if (err) {
        return res.status(400).json({ error: err.message });
      }

      const uploadedFiles = (req.files as { images?: Express.Multer.File[]; image?: Express.Multer.File[] } | undefined);
      const files = [
        ...(uploadedFiles?.images ?? []),
        ...(uploadedFiles?.image ?? []),
      ];

      if (!files.length) {
        return res.status(400).json({ error: 'No image files provided. Use field name "images" or "image".' });
      }

      try {
        const imageUrls = await uploadMultipleToCloudinary(files.map((file) => file.buffer));
        res.status(201).json({
          imageUrl: imageUrls[0],
          imageUrls,
        });
      } catch (uploadError: any) {
        console.error('Cloudinary upload error:', uploadError);
        res.status(500).json({ error: 'Failed to upload image(s) to Cloudinary' });
      }
    });
  }
);

export default router;
