import { Router, Request, Response } from 'express';
import multer from 'multer';
import { uploadToCloudinary } from '../cloudinary';
import { requireAdmin } from './settings';

const router = Router();

// Store file in memory so we can stream it directly to Cloudinary
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
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
 * Accepts a single image file under the field name "image".
 * Requires admin authentication.
 * Returns: { imageUrl: string }
 */
router.post(
  '/',
  async (req: Request, res: Response) => {
    // Admin check before processing the file
    if (!(await requireAdmin(req, res))) return;

    // Run multer manually so we can handle its errors cleanly
    upload.single('image')(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Image must be 5 MB or smaller' });
        }
        return res.status(400).json({ error: err.message });
      }

      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided. Use field name "image".' });
      }

      try {
        const imageUrl = await uploadToCloudinary(req.file.buffer);
        res.status(201).json({ imageUrl });
      } catch (uploadError: any) {
        console.error('Cloudinary upload error:', uploadError);
        res.status(500).json({ error: 'Failed to upload image to Cloudinary' });
      }
    });
  }
);

export default router;
