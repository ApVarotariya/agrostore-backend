import mongoose from 'mongoose';
import { Router, Request, Response } from 'express';
import PDFDocument from 'pdfkit';
import Product from '../models/Product';
import Invoice from '../models/Invoice';
import Setting from '../models/Setting';
import { requireAdmin } from './settings';

const router = Router();

function generateInvoiceId(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randNum = Math.floor(1000 + Math.random() * 9000);
  return `INV-${dateStr}-${randNum}`;
}

// POST /api/invoices — create invoice, deduct stock atomically
// Accepts optional admin-overridden unitPrice per item and paymentStatus
router.post('/', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { customerName, customerPhone, items, paymentStatus } = req.body;
  if (!customerName || !customerPhone || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing required customer details or invoice items' });
  }

  const status: 'paid' | 'unpaid' =
    paymentStatus === 'paid' ? 'paid' : 'unpaid';

  // Normalise phone to digits-only so all queries are consistent
  const normalisedPhone = String(customerPhone).replace(/\D/g, '');

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

      // Allow admin to override the unit price; fall back to product/variant price
      const adminOverridePrice =
        item.unitPrice !== undefined && Number.isFinite(Number(item.unitPrice)) && Number(item.unitPrice) >= 0
          ? Number(item.unitPrice)
          : null;

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
          productName: product.name,
          quantity,
          unit: product.unit,
          unitPrice: adminOverridePrice !== null ? adminOverridePrice : variant.price,
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
          unitPrice: adminOverridePrice !== null ? adminOverridePrice : product.price,
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
          { $inc: { 'variants.$.stock': -item.quantity } },
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
          customerPhone: normalisedPhone,   // store normalised digits-only
          items: validatedItems,
          grandTotal,
          paymentStatus: status,
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
      paymentStatus: status,
      createdAt: invoice[0].createdAt,
    });
  } catch (error: any) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
});

// GET /api/invoices/customer-balance/:phone
// Returns total unpaid balance for a customer by phone number.
// Pass ?excludeId=INV-xxx to exclude the invoice just created.
router.get('/customer-balance/:phone', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { phone } = req.params;
  const { excludeId } = req.query;

  // Normalise to digits-only to match stored phone format
  const normalisedPhone = phone.replace(/\D/g, '');

  try {
    const matchStage: any = {
      customerPhone: normalisedPhone,
      paymentStatus: 'unpaid',
    };
    if (excludeId) {
      matchStage._id = { $ne: excludeId };
    }

    const result = await Invoice.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          unpaidCount: { $sum: 1 },
          unpaidTotal: { $sum: '$grandTotal' },
        },
      },
    ]);

    const { unpaidCount = 0, unpaidTotal = 0 } = result[0] ?? {};
    res.json({ unpaidCount, unpaidTotal });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/reports/summary
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

    // Total unpaid balance across all invoices
    const unpaidResult = await Invoice.aggregate([
      { $match: { paymentStatus: 'unpaid' } },
      {
        $group: {
          _id: null,
          unpaidCount: { $sum: 1 },
          unpaidTotal: { $sum: '$grandTotal' },
        },
      },
    ]);
    const unpaid = unpaidResult[0] || { unpaidCount: 0, unpaidTotal: 0 };

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
      unpaid,
      lowStock,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices — list all invoices with paymentStatus
router.get('/', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 }).lean();
    res.json(invoices);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/invoices/:id/payment — toggle or set paymentStatus (paid / unpaid)
router.patch('/:id/payment', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const { id } = req.params;
  const { paymentStatus } = req.body;

  if (paymentStatus !== 'paid' && paymentStatus !== 'unpaid') {
    return res.status(400).json({ error: 'paymentStatus must be "paid" or "unpaid"' });
  }

  try {
    const invoice = await Invoice.findByIdAndUpdate(
      id,
      { $set: { paymentStatus } },
      { new: true }
    ).lean();

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    res.json({ success: true, invoiceId: id, paymentStatus: invoice.paymentStatus });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/:id/pdf — generate PDF on the fly
router.get('/:id/pdf', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const invoice = await Invoice.findById(id).lean();
    if (!invoice) {
      return res.status(404).send('Invoice not found');
    }

    // Load store name from settings, fallback to 'AgroStore'
    let storeName = 'AgroStore';
    let storeSubtitle = 'Quality Seeds, Fertilizers & Pesticides';
    try {
      const nameDoc = await Setting.findById('store_name').lean();
      if (nameDoc?.value) storeName = nameDoc.value;
    } catch { /* use defaults */ }

    const items = invoice.items;
    const paymentStatus = (invoice as any).paymentStatus ?? 'paid';
    const isPaid = paymentStatus === 'paid';

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

    // ── Header ──────────────────────────────────────────────────────────
    doc.fillColor('#2E7D32').fontSize(26).text(storeName, 50, 50);
    doc.fillColor('#555555').fontSize(10).text(storeSubtitle, 50, 80);
    doc.fillColor('#2E7D32').fontSize(20).text('INVOICE', 400, 50, { align: 'right' });

    doc.fillColor('#333333').fontSize(10);
    doc.text(`Invoice ID: ${invoice._id}`, 300, 75, { align: 'right', width: 250 });
    doc.text(`Date: ${formattedDate}`, 300, 90, { align: 'right', width: 250 });

    // Payment status pill (top-right)
    const pillColor = isPaid ? '#2E7D32' : '#E65100';
    const pillLabel = isPaid ? '✓  PAID' : '⚠  UNPAID';
    doc.rect(400, 108, 145, 20).fill(isPaid ? '#E8F5E9' : '#FFF3E0');
    doc.fillColor(pillColor).fontSize(9).text(pillLabel, 400, 113, { align: 'center', width: 145 });

    doc.moveTo(50, 135).lineTo(545, 135).strokeColor('#E0E0E0').lineWidth(1).stroke();

    // ── Bill To ─────────────────────────────────────────────────────────
    doc.fillColor('#2E7D32').fontSize(11).text('BILL TO:', 50, 150);
    doc.fillColor('#333333').fontSize(13).text(invoice.customerName, 50, 165);
    doc.fontSize(10).text(`Phone: ${invoice.customerPhone}`, 50, 183);

    doc.moveTo(50, 205).lineTo(545, 205).strokeColor('#E0E0E0').lineWidth(1).stroke();

    // ── Table header ────────────────────────────────────────────────────
    const tableTop = 220;
    doc.rect(50, tableTop, 495, 24).fill('#2E7D32');
    doc.fillColor('#FFFFFF').fontSize(10);
    doc.text('#', 60, tableTop + 7, { width: 25 });
    doc.text('Item Description', 88, tableTop + 7, { width: 225 });
    doc.text('Pack Size', 316, tableTop + 7, { width: 70 });
    doc.text('Qty', 390, tableTop + 7, { width: 45, align: 'right' });
    doc.text('Rate', 438, tableTop + 7, { width: 50, align: 'right' });
    doc.text('Amount', 492, tableTop + 7, { width: 50, align: 'right' });

    // ── Table rows ──────────────────────────────────────────────────────
    let y = tableTop + 24;
    items.forEach((item, index) => {
      const rowBg = index % 2 === 0 ? '#FFFFFF' : '#F9FBF9';
      doc.rect(50, y, 495, 22).fill(rowBg);

      doc.fillColor('#333333').fontSize(10);
      doc.text(String(index + 1), 60, y + 6, { width: 25 });
      doc.text(item.productName, 88, y + 6, { width: 225 });
      doc.text(item.packSize ?? '—', 316, y + 6, { width: 70 });
      doc.text(`${item.quantity} ${item.unit}`, 390, y + 6, { width: 45, align: 'right' });
      doc.text(`₹${item.unitPrice.toFixed(2)}`, 438, y + 6, { width: 50, align: 'right' });
      const rowTotal = item.unitPrice * item.quantity;
      doc.text(`₹${rowTotal.toFixed(2)}`, 492, y + 6, { width: 50, align: 'right' });

      y += 22;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#E8E8E8').lineWidth(0.5).stroke();
    });

    // ── Totals ───────────────────────────────────────────────────────────
    y += 16;
    doc.rect(330, y, 215, 32).fill('#E8F5E9');
    doc.fillColor('#2E7D32').fontSize(12).text('Grand Total:', 340, y + 10);
    doc.fillColor('#1B5E20').fontSize(14)
      .text(`₹${invoice.grandTotal.toFixed(2)}`, 440, y + 9, { align: 'right', width: 95 });

    // If unpaid, show outstanding notice box below totals
    if (!isPaid) {
      y += 46;
      doc.rect(50, y, 495, 36).fill('#FFF3E0');
      doc.fillColor('#E65100').fontSize(11)
        .text('⚠  PAYMENT PENDING', 60, y + 4, { width: 300 });
      doc.fontSize(9).fillColor('#BF360C')
        .text(
          `Outstanding balance: ₹${invoice.grandTotal.toFixed(2)}  —  Please clear payment at your earliest convenience.`,
          60, y + 18, { width: 480 }
        );
    }

    // ── Footer ────────────────────────────────────────────────────────────
    const footerTop = 720;
    doc.moveTo(50, footerTop).lineTo(545, footerTop).strokeColor('#2E7D32').lineWidth(1.5).stroke();
    doc.fillColor('#2E7D32').fontSize(11)
      .text(`Thank you for shopping at ${storeName}! 🌾`, 50, footerTop + 15, { align: 'center' });
    doc.fillColor('#777777').fontSize(8.5)
      .text('This is a computer-generated invoice and requires no signature.', 50, footerTop + 32, { align: 'center' });

    doc.end();
  } catch (error: any) {
    res.status(500).send('Error generating invoice PDF: ' + error.message);
  }
});

export default router;
