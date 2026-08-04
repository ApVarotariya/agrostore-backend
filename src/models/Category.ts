import mongoose, { Schema, Document } from 'mongoose';

export interface CategoryDocument extends Document {
  key: string;
  label: string;
  emoji: string;
}

const categorySchema = new Schema<CategoryDocument>(
  {
    key: { type: String, required: true, unique: true, trim: true, lowercase: true },
    label: { type: String, required: true, trim: true },
    emoji: { type: String, required: true, trim: true, default: '📦' },
  },
  { timestamps: false, versionKey: false }
);

export default mongoose.model<CategoryDocument>('Category', categorySchema);
