import mongoose, { Schema, Document } from 'mongoose';

export interface ProductDocument extends Document {
  _id: string;
  name: string;
  category: string;
  price: number;
  unit: string;
  stock: number;
  description?: string;
  imageUrl?: string;
  brand?: string;
  packSize?: string;
  cropSuitability?: string;
  applicationGuide?: string;
  activeIngredient?: string;
  batchNumber?: string;
  expiryDate?: string;
  lowStockThreshold: number;
}

const productSchema = new Schema<ProductDocument>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    stock: { type: Number, required: true, min: 0 },
    description: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    brand: { type: String, trim: true },
    packSize: { type: String, trim: true },
    cropSuitability: { type: String, trim: true },
    applicationGuide: { type: String, trim: true },
    activeIngredient: { type: String, trim: true },
    batchNumber: { type: String, trim: true },
    expiryDate: { type: String, trim: true },
    lowStockThreshold: { type: Number, required: true, default: 5, min: 0 },
  },
  { timestamps: false, versionKey: false }
);

export default mongoose.model<ProductDocument>('Product', productSchema);
