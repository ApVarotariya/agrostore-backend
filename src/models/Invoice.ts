import mongoose, { Schema, Document } from 'mongoose';

export interface InvoiceItem {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

export interface InvoiceDocument extends Document {
  _id: string;
  customerName: string;
  customerPhone: string;
  items: InvoiceItem[];
  grandTotal: number;
  createdAt: string;
}

const invoiceItemSchema = new Schema<InvoiceItem>(
  {
    productId: { type: String, required: true, trim: true },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unit: { type: String, required: true, trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const invoiceSchema = new Schema<InvoiceDocument>(
  {
    _id: { type: String, required: true },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },
    items: { type: [invoiceItemSchema], required: true },
    grandTotal: { type: Number, required: true, min: 0 },
    createdAt: { type: String, required: true },
  },
  { timestamps: false, versionKey: false }
);

export default mongoose.model<InvoiceDocument>('Invoice', invoiceSchema);
