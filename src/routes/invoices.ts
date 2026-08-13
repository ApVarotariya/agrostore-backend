import mongoose from 'mongoose';
import { Router, Request, Response } from 'express';
import PDFDocument from 'pdfkit';
import Product from '../models/Product';
import Invoice from '../models/Invoice';
import { requireAdmin } from './settings';

const router = Router();

function generateInvoiceId(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randNum = Math.floor(1000 + Math.random() * 9000);
  return `INV-${dateStr}-${randNum}`;
}

router.post('/', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { customerName, customerPhone, items } = req.body;
  if (!customerName || !customerPhone || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing required customer details or invoice items' });
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const validatedItems = [] as Array<{
      productId: string;
      productName: string;
      quantity: number;
      unit: string;
      unitPrice: number;
      variantId?: string;
      packSize?: string;
    }>;

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!item.productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for ${item.productName || item.productId}`);
      }

      const product = await Product.findById(item.productId).session(session).lean();
      if (!product) {
        throw new Error(`Product not found: ${item.productName || item.productId}`);
      }

      if (item.variantId) {
        const variant = product.variants?.find((v: any) => v.id === item.variantId);
        if (!variant) {
          throw new Error(`Variant not found for ${product.name}`);
        }
        if (quantity > variant.stock) {
          throw new Error(`Insufficient stock for ${product.name} (${variant.packSize})`);
        }
        validatedItems.push({
          productId: item.productId,
          productName: `${product.name} (${variant.packSize})`,
          quantity,
          unit: product.unit,
          unitPrice: variant.price,
          variantId: item.variantId,
          packSize: variant.packSize,
        });
      } else {
        if (quantity > product.stock) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }
        validatedItems.push({
          productId: item.productId,
          productName: product.name,
          quantity,
          unit: product.unit,
          unitPrice: product.price,
        });
      }
    }

    for (const item of validatedItems) {
      let updateResult;
      if (item.variantId) {
        updateResult = await Product.updateOne(
          {
            _id: item.productId,
            variants: { $elemMatch: { id: item.variantId, stock: { $gte: item.quantity } } }
          },
          { $inc: { "variants.$.stock": -item.quantity } },
          { session }
        );
      } else {
        updateResult = await Product.updateOne(
          { _id: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } },
          { session }
        );
      }

      if (updateResult.modifiedCount !== 1) {
        throw new Error(`Stock changed while invoicing ${item.productName}`);
      }
    }

    const grandTotal = validatedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const invoice = await Invoice.create(
      [
        {
          _id: generateInvoiceId(),
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim(),
          items: validatedItems,
          grandTotal,
          createdAt: new Date().toISOString(),
        },
      ],
      { session }
    );

    await session.commitTransaction();

    const host = req.get('host');
    const protocol = req.protocol;
    const pdfUrl = `${protocol}://${host}/api/invoices/${invoice[0]._id}/pdf`;

    res.status(201).json({
      success: true,
      invoiceId: invoice[0]._id,
      pdfUrl,
      grandTotal,
      createdAt: invoice[0].createdAt,
    });
  } catch (error: any) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
});

router.get('/', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 }).lean();
    res.json(invoices);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/summary', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    const totalsResult = await Invoice.aggregate([
      {
        $group: {
          _id: null,
          invoiceCount: { $sum: 1 },
          revenue: { $sum: '$grandTotal' },
        },
      },
    ]);

    const totals = totalsResult[0] || { invoiceCount: 0, revenue: 0 };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const todayInvoices = await Invoice.countDocuments({
      createdAt: {
        $gte: todayStart.toISOString(),
        $lt: todayEnd.toISOString(),
      },
    });

    const todayRevenueResult = await Invoice.aggregate([
      {
        $match: {
          createdAt: {
            $gte: todayStart.toISOString(),
            $lt: todayEnd.toISOString(),
          },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: '$grandTotal' },
        },
      },
    ]);

    const todayRevenue = todayRevenueResult[0]?.revenue || 0;

    const lowStock = await Product.aggregate([
      {
        $match: {
          $expr: { $lte: ['$stock', '$lowStockThreshold'] },
        },
      },
      { $sort: { stock: 1, name: 1 } },
      {
        $project: {
          id: '$_id',
          name: 1,
          category: 1,
          price: 1,
          unit: 1,
          stock: 1,
          lowStockThreshold: 1,
          description: 1,
          imageUrl: 1,
          brand: 1,
          packSize: 1,
          cropSuitability: 1,
          applicationGuide: 1,
          activeIngredient: 1,
          batchNumber: 1,
          expiryDate: 1,
        },
      },
    ]);

    res.json({
      totals,
      today: { invoiceCount: todayInvoices, revenue: todayRevenue },
      lowStock,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/pdf', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const invoice = await Invoice.findById(id).lean();
    if (!invoice) {
      return res.status(404).send('Invoice not found');
    }

    const items = invoice.items;
    const dateObj = new Date(invoice.createdAt);
    const formattedDate = dateObj.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${id}.pdf"`);
    doc.pipe(res);

    doc.fillColor('#2E7D32').fontSize(26).text('AgroStore', 50, 50);
    doc.fillColor('#555555').fontSize(10).text('Quality Seeds, Fertilizers & Pesticides', 50, 80);
    doc.fillColor('#2E7D32').fontSize(20).text('INVOICE', 400, 50, { align: 'right' });

    doc.fillColor('#333333').fontSize(10);
    doc.text(`Invoice ID: ${invoice._id}`, 300, 75, { align: 'right', width: 250 });
    doc.text(`Date: ${formattedDate}`, 300, 90, { align: 'right', width: 250 });

    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#E0E0E0').lineWidth(1).stroke();

    doc.fillColor('#2E7D32').fontSize(11).text('BILL TO:', 50, 135);
    doc.fillColor('#333333').fontSize(13).text(invoice.customerName, 50, 150);
    doc.fontSize(10).text(`Customer Phone: ${invoice.customerPhone}`, 50, 168);

    doc.moveTo(50, 190).lineTo(545, 190).strokeColor('#E0E0E0').lineWidth(1).stroke();

    const tableTop = 210;
    doc.rect(50, tableTop, 495, 24).fill('#2E7D32');
    doc.fillColor('#FFFFFF').fontSize(10);
    doc.text('S.No.', 60, tableTop + 7);
    doc.text('Item Description', 100, tableTop + 7);
    doc.text('Quantity', 320, tableTop + 7, { width: 60, align: 'right' });
    doc.text('Rate', 390, tableTop + 7, { width: 70, align: 'right' });
    doc.text('Amount', 470, tableTop + 7, { width: 65, align: 'right' });

    let y = tableTop + 24;
    items.forEach((item, index) => {
      y += 8;
      doc.fillColor('#333333').fontSize(10);
      doc.text(String(index + 1), 60, y);
      doc.text(item.productName, 100, y, { width: 210 });
      doc.text(`${item.quantity} ${item.unit}`, 320, y, { width: 60, align: 'right' });
      doc.text(`INR ${item.unitPrice.toFixed(2)}`, 390, y, { width: 70, align: 'right' });
      const rowTotal = item.unitPrice * item.quantity;
      doc.text(`INR ${rowTotal.toFixed(2)}`, 470, y, { width: 65, align: 'right' });
      y += 18;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#F0F0F0').lineWidth(0.5).stroke();
    });

    y += 25;
    doc.rect(300, y, 245, 36).fill('#E8F5E9');
    doc.fillColor('#2E7D32').fontSize(12).text('Grand Total:', 315, y + 13);
    doc.fillColor('#1B5E20').fontSize(15).text(`INR ${invoice.grandTotal.toFixed(2)}`, 410, y + 11, {
      align: 'right',
      width: 120,
    });

    const footerTop = 720;
    doc.moveTo(50, footerTop).lineTo(545, footerTop).strokeColor('#2E7D32').lineWidth(1.5).stroke();
    doc.fillColor('#2E7D32').fontSize(11).text('Thank you for shopping at AgroStore! 🌾', 50, footerTop + 15, { align: 'center' });
    doc.fillColor('#777777').fontSize(8.5).text('This is a computer-generated invoice and requires no signature.', 50, footerTop + 32, { align: 'center' });

    doc.end();
  } catch (error: any) {
    res.status(500).send('Error generating invoice PDF: ' + error.message);
  }
});

export default router;
