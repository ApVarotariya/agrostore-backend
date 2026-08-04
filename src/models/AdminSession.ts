import mongoose, { Schema, Document } from 'mongoose';

export interface AdminSessionDocument extends Document {
  token: string;
  expiresAt: string;
  deviceId: string;
}

const adminSessionSchema = new Schema<AdminSessionDocument>(
  {
    token: { type: String, required: true, unique: true, trim: true },
    expiresAt: { type: String, required: true },
    deviceId: { type: String, required: true, trim: true },
  },
  { timestamps: false, versionKey: false }
);

export default mongoose.model<AdminSessionDocument>('AdminSession', adminSessionSchema);
