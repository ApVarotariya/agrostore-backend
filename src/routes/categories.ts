import mongoose from 'mongoose';
import { Router, Request, Response } from 'express';
import { requireAdmin } from './settings';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const Category = mongoose.model('Category');
    const categories = await Category.find().sort({ label: 1 }).lean().exec();
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  const { key, label, emoji } = req.body;
  const normalized = String(key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!normalized || !label) return res.status(400).json({ error: 'Category name is required' });

  try {
    const Category = mongoose.model('Category');
    await Category.create({ key: normalized, label: String(label).trim(), emoji: emoji || '📦' });
    res.status(201).json({ key: normalized, label: String(label).trim(), emoji: emoji || '📦' });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Category already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:key', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const Category = mongoose.model('Category');
  const Product = mongoose.model('Product');

  const inUse = await Product.countDocuments({ category: req.params.key }).exec();
  if (inUse > 0) return res.status(400).json({ error: 'Move or delete products in this category first' });

  await Category.deleteOne({ key: req.params.key }).exec();
  res.json({ message: 'Category removed' });
});

export default router;
