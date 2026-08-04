import mongoose, { Schema, Document } from 'mongoose';

export interface AdminDeviceDocument extends Document {
  deviceId: string;
  name: string;
  phone?: string;
  active: boolean;
  createdAt: string;
}

const adminDeviceSchema = new Schema<AdminDeviceDocument>(
  {
    deviceId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    active: { type: Boolean, required: true, default: true },
    createdAt: { type: String, required: true },
  },
  { timestamps: false, versionKey: false }
);

export default mongoose.model<AdminDeviceDocument>('AdminDevice', adminDeviceSchema);
