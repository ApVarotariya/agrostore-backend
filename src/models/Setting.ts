import mongoose, { Schema, Document } from 'mongoose';

export interface SettingDocument extends Document {
  _id: string;
  value: string;
}

const settingSchema = new Schema<SettingDocument>(
  {
    _id: { type: String, required: true },
    value: { type: String, required: true },
  },
  { timestamps: false, versionKey: false }
);

export default mongoose.model<SettingDocument>('Setting', settingSchema);
