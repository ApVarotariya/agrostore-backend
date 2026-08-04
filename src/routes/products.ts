import mongoose from 'mongoose';
import { Router, Request, Response } from 'express';
import Product from '../models/Product';
import { requireAdmin } from './settings';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const products = await Product.find().sort({ name: 1 }).lean();
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const {
    id,
    name,
    category,
    price,
    unit,
    stock,
    description,
    imageUrl,
    brand,
    packSize,
    cropSuitability,
    applicationGuide,
    activeIngredient,
    batchNumber,
    expiryDate,
    lowStockThreshold,
  } = req.body;

  if (!id || !name || !category || price === undefined || !unit || stock === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const product = new Product({
      _id: id,
      name,
      category,
      price,
      unit,
      stock,
      description: description || undefined,
      imageUrl: imageUrl || undefined,
      brand: brand || undefined,
      packSize: packSize || undefined,
      cropSuitability: cropSuitability || undefined,
      applicationGuide: applicationGuide || undefined,
      activeIngredient: activeIngredient || undefined,
      batchNumber: batchNumber || undefined,
      expiryDate: expiryDate || undefined,
      lowStockThreshold: Number(lowStockThreshold) || 5,
    });

    await product.save();
    res.status(201).json(product.toJSON());
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Product with this id already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { id } = req.params;
  const {
    name,
    category,
    price,
    unit,
    stock,
    description,
    imageUrl,
    brand,
    packSize,
    cropSuitability,
    applicationGuide,
    activeIngredient,
    batchNumber,
    expiryDate,
    lowStockThreshold,
  } = req.body;

  if (!name || !category || price === undefined || !unit || stock === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      {
        name,
        category,
        price,
        unit,
        stock,
        description: description || undefined,
        imageUrl: imageUrl || undefined,
        brand: brand || undefined,
        packSize: packSize || undefined,
        cropSuitability: cropSuitability || undefined,
        applicationGuide: applicationGuide || undefined,
        activeIngredient: activeIngredient || undefined,
        batchNumber: batchNumber || undefined,
        expiryDate: expiryDate || undefined,
        lowStockThreshold: Number(lowStockThreshold) || 5,
      },
      { new: true, runValidators: true }
    ).lean();

    if (!updatedProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(updatedProduct);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/deduct-stock', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Invalid or missing items array' });
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    for (const item of items) {
      if (!item.productId || item.quantity === undefined) {
        throw new Error('Invalid item: missing productId or quantity');
      }

      const updateResult = await Product.updateOne(
        { _id: item.productId },
        { $inc: { stock: -Number(item.quantity) } },
        { session }
      );

      if (updateResult.matchedCount === 0) {
        throw new Error(`Product not found: ${item.productId}`);
      }
    }

    await session.commitTransaction();
    res.json({ success: true, message: 'Stock deducted successfully' });
  } catch (error: any) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { id } = req.params;

  try {
    const deletedProduct = await Product.findByIdAndDelete(id).lean();
    if (!deletedProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully', id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
