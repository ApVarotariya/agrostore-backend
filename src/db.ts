import mongoose from 'mongoose';
import './models/Product';
import './models/Category';
import './models/Setting';
import './models/AdminDevice';
import './models/AdminSession';
import './models/Invoice';

const DEFAULT_CATEGORIES = [
  { key: 'pesticide', label: 'Pesticides', emoji: '🧪' },
  { key: 'seed', label: 'Seeds', emoji: '🌱' },
  { key: 'fertilizer', label: 'Fertilizers', emoji: '🌿' },
];

const STORE_DEFAULTS: Record<string, string> = {
  store_name: 'AgroStore',
  store_whatsapp: '919510565151',
  store_phone: '',
  store_address: '',
  store_hours: 'Mon–Sat, 9:00 AM–7:00 PM',
  currency: '₹',
  low_stock_threshold: '5',
};

export async function connectMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required for backend startup. Set it in environment variables.');
  }

  await mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || undefined,
    autoIndex: true,
  });

  await seedDefaults();
}

async function seedDefaults(): Promise<void> {
  const Category = mongoose.model('Category');
  const Setting = mongoose.model('Setting');

  for (const category of DEFAULT_CATEGORIES) {
    await Category.updateOne({ key: category.key }, category, { upsert: true }).exec();
  }

  for (const [key, value] of Object.entries(STORE_DEFAULTS)) {
    await Setting.updateOne({ _id: key }, { value }, { upsert: true }).exec();
  }
}
