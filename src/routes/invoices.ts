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

    // ── Load store settings ──────────────────────────────────────────────
    let storeName    = 'AgroStore';
    let storePhone   = '';
    let storeAddress = '';
    let storeTagline = 'Quality Seeds, Fertilizers & Pesticides';
    try {
      const settingDocs = await Setting.find({
        _id: { $in: ['store_name', 'store_phone', 'store_address', 'store_tagline'] },
      }).lean();
      const map: Record<string, string> = {};
      settingDocs.forEach((s: any) => { map[s._id] = s.value; });
      if (map.store_name)    storeName    = map.store_name;
      if (map.store_phone)   storePhone   = map.store_phone;
      if (map.store_address) storeAddress = map.store_address;
      if (map.store_tagline) storeTagline = map.store_tagline;
    } catch { /* use defaults */ }

    const items       = invoice.items;
    const payStatus   = (invoice as any).paymentStatus ?? 'paid';
    const isPaid      = payStatus === 'paid';

    const dateObj      = new Date(invoice.createdAt);
    const formattedDate = dateObj.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
    const formattedTime = dateObj.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true,
    });

    // ── Palette ──────────────────────────────────────────────────────────
    const GREEN       = '#1B5E20';
    const GREEN_MID   = '#2E7D32';
    const GREEN_LIGHT = '#E8F5E9';
    const GREEN_CHIP  = '#A5D6A7';
    const ORANGE      = '#E65100';
    const ORANGE_BG   = '#FFF3E0';
    const SLATE       = '#1E293B';
    const SLATE_MID   = '#475569';
    const SLATE_LIGHT = '#94A3B8';
    const SURFACE     = '#FFFFFF';
    const ROW_ALT     = '#F8FFFE';
    const BORDER      = '#E2E8F0';

    // ── Page setup ───────────────────────────────────────────────────────
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${id}.pdf"`);
    doc.pipe(res);

    const PW = 595.28;   // A4 width  pt
    const PH = 841.89;   // A4 height pt
    const PAD = 40;      // outer margin

    // ── Top accent bar ────────────────────────────────────────────────────
    doc.rect(0, 0, PW, 6).fill(GREEN_MID);

    // ── Header card ───────────────────────────────────────────────────────
    // Left: store branding
    doc.fillColor(GREEN).fontSize(28).font('Helvetica-Bold')
       .text(storeName, PAD, 24, { lineBreak: false });

    doc.fillColor(SLATE_MID).fontSize(9).font('Helvetica')
       .text(storeTagline, PAD, 57, { lineBreak: false });

    if (storePhone || storeAddress) {
      const contactLine = [storePhone, storeAddress].filter(Boolean).join('  ·  ');
      doc.fillColor(SLATE_LIGHT).fontSize(8)
         .text(contactLine, PAD, 70, { lineBreak: false });
    }

    // Right: INVOICE label + meta
    doc.fillColor(GREEN_MID).fontSize(22).font('Helvetica-Bold')
       .text('INVOICE', PW - PAD - 150, 24, { width: 150, align: 'right' });

    doc.fillColor(SLATE).fontSize(9).font('Helvetica-Bold')
       .text(String(invoice._id), PW - PAD - 150, 52, { width: 150, align: 'right' });

    doc.fillColor(SLATE_MID).fontSize(8).font('Helvetica')
       .text(`${formattedDate}  ${formattedTime}`, PW - PAD - 150, 65, { width: 150, align: 'right' });

    // Payment status pill (right side)
    const pillW = 80; const pillH = 18; const pillX = PW - PAD - pillW; const pillY = 80;
    doc.roundedRect(pillX, pillY, pillW, pillH, 9)
       .fill(isPaid ? GREEN_LIGHT : ORANGE_BG);
    doc.fillColor(isPaid ? GREEN_MID : ORANGE).fontSize(8).font('Helvetica-Bold')
       .text(isPaid ? '✓  PAID' : '⚠  UNPAID', pillX, pillY + 5, { width: pillW, align: 'center' });

    // Divider
    doc.moveTo(PAD, 108).lineTo(PW - PAD, 108)
       .strokeColor(GREEN_CHIP).lineWidth(1).stroke();

    // ── Bill To block ──────────────────────────────────────────────────────
    const billY = 118;
    doc.roundedRect(PAD, billY, 220, 68, 8).fill('#F0FDF4');
    doc.fillColor(GREEN_MID).fontSize(7.5).font('Helvetica-Bold')
       .text('BILL TO', PAD + 12, billY + 10);
    doc.fillColor(SLATE).fontSize(13).font('Helvetica-Bold')
       .text(invoice.customerName, PAD + 12, billY + 22, { width: 196 });
    doc.fillColor(SLATE_MID).fontSize(9).font('Helvetica')
       .text(invoice.customerPhone, PAD + 12, billY + 42);

    // ── Summary block (right side of Bill To) ─────────────────────────────
    const sumX = PAD + 240; const sumY = billY;
    doc.roundedRect(sumX, sumY, 275, 68, 8).fill(GREEN_LIGHT);

    const colA = sumX + 14; const colB = sumX + 145;
    const r1 = sumY + 10; const r2 = sumY + 28; const r3 = sumY + 46;

    doc.fillColor(SLATE_LIGHT).fontSize(7).font('Helvetica').text('INVOICE DATE', colA, r1);
    doc.fillColor(SLATE).fontSize(9).font('Helvetica-Bold').text(formattedDate, colA, r1 + 9);

    doc.fillColor(SLATE_LIGHT).fontSize(7).font('Helvetica').text('INVOICE ID', colA, r2);
    doc.fillColor(SLATE).fontSize(8).font('Helvetica-Bold').text(String(invoice._id), colA, r2 + 9);

    doc.fillColor(SLATE_LIGHT).fontSize(7).font('Helvetica').text('ITEMS', colB, r1);
    doc.fillColor(SLATE).fontSize(9).font('Helvetica-Bold').text(String(items.length), colB, r1 + 9);

    doc.fillColor(SLATE_LIGHT).fontSize(7).font('Helvetica').text('PAYMENT', colB, r2);
    doc.fillColor(isPaid ? GREEN_MID : ORANGE).fontSize(9).font('Helvetica-Bold')
       .text(isPaid ? 'Paid' : 'Unpaid', colB, r2 + 9);

    // ── Table ──────────────────────────────────────────────────────────────
    const tTop = billY + 80;

    // Table header
    doc.rect(PAD, tTop, PW - PAD * 2, 22).fill(GREEN);
    doc.fillColor(SURFACE).fontSize(8.5).font('Helvetica-Bold');

    // Col positions: #  |  Item  |  Pack  |  Qty  |  Rate  |  Amount
    const C = {
      num:    PAD + 8,
      item:   PAD + 30,
      pack:   PAD + 248,
      qty:    PAD + 330,
      rate:   PAD + 380,
      amount: PAD + 440,
    };
    const TW = {
      num:    20,
      item:   210,
      pack:   74,
      qty:    44,
      rate:   54,
      amount: 65,
    };

    doc.text('#',           C.num,    tTop + 7, { width: TW.num,    align: 'center' });
    doc.text('Item',        C.item,   tTop + 7, { width: TW.item });
    doc.text('Pack Size',   C.pack,   tTop + 7, { width: TW.pack });
    doc.text('Qty',         C.qty,    tTop + 7, { width: TW.qty,    align: 'right' });
    doc.text('Rate',        C.rate,   tTop + 7, { width: TW.rate,   align: 'right' });
    doc.text('Amount',      C.amount, tTop + 7, { width: TW.amount, align: 'right' });

    // Table rows
    let y = tTop + 22;
    items.forEach((item, idx) => {
      const rowH  = 24;
      const rowBg = idx % 2 === 0 ? SURFACE : ROW_ALT;
      doc.rect(PAD, y, PW - PAD * 2, rowH).fill(rowBg);

      doc.fillColor(SLATE_MID).fontSize(8.5).font('Helvetica')
         .text(String(idx + 1), C.num, y + 8, { width: TW.num, align: 'center' });

      doc.fillColor(SLATE).fontSize(9).font('Helvetica-Bold')
         .text(item.productName, C.item, y + 7, { width: TW.item });

      // Bug 3 — variant shows packSize only; base shows unit
      const packLabel = item.packSize ? item.packSize : '—';
      doc.fillColor(SLATE_MID).fontSize(8.5).font('Helvetica')
         .text(packLabel, C.pack, y + 8, { width: TW.pack });

      // Qty: for variants just the number; for base products number + unit
      const qtyLabel = item.packSize
        ? String(item.quantity)
        : `${item.quantity} ${item.unit}`;
      doc.fillColor(SLATE_MID).fontSize(8.5).font('Helvetica')
         .text(qtyLabel, C.qty, y + 8, { width: TW.qty, align: 'right' });

      doc.fillColor(SLATE_MID).fontSize(8.5).font('Helvetica')
         .text(`₹${item.unitPrice.toFixed(2)}`, C.rate, y + 8, { width: TW.rate, align: 'right' });

      const rowTotal = item.unitPrice * item.quantity;
      doc.fillColor(SLATE).fontSize(9).font('Helvetica-Bold')
         .text(`₹${rowTotal.toFixed(2)}`, C.amount, y + 7, { width: TW.amount, align: 'right' });

      y += rowH;

      // thin separator
      doc.moveTo(PAD, y).lineTo(PW - PAD, y).strokeColor(BORDER).lineWidth(0.4).stroke();
    });

    // ── Totals section ─────────────────────────────────────────────────────
    y += 12;

    // Subtotal line
    doc.fillColor(SLATE_MID).fontSize(9).font('Helvetica')
       .text('Subtotal', C.rate - 60, y, { width: 100, align: 'right' });
    doc.fillColor(SLATE).fontSize(9).font('Helvetica')
       .text(`₹${invoice.grandTotal.toFixed(2)}`, C.amount, y, { width: TW.amount, align: 'right' });

    y += 14;
    // Divider above grand total
    doc.moveTo(C.rate - 60, y).lineTo(PW - PAD, y).strokeColor(BORDER).lineWidth(0.6).stroke();
    y += 8;

    // Grand total row
    const gtH = 32;
    doc.roundedRect(C.rate - 70, y, 70 + TW.amount + 10, gtH, 6).fill(GREEN);
    doc.fillColor(SURFACE).fontSize(10).font('Helvetica-Bold')
       .text('Grand Total', C.rate - 60, y + 10, { width: 100, align: 'right' });
    doc.fillColor(SURFACE).fontSize(13).font('Helvetica-Bold')
       .text(`₹${invoice.grandTotal.toFixed(2)}`, C.amount - 4, y + 9, { width: TW.amount + 4, align: 'right' });

    y += gtH + 12;

    // ── Unpaid notice ──────────────────────────────────────────────────────
    if (!isPaid) {
      const noticeH = 48;
      doc.roundedRect(PAD, y, PW - PAD * 2, noticeH, 8).fill(ORANGE_BG);
      doc.moveTo(PAD, y).lineTo(PAD, y + noticeH).strokeColor(ORANGE).lineWidth(3).stroke();
      doc.fillColor(ORANGE).fontSize(10).font('Helvetica-Bold')
         .text('Payment Pending', PAD + 14, y + 8);
      doc.fillColor(SLATE_MID).fontSize(8.5).font('Helvetica')
         .text(
           `Outstanding balance: ₹${invoice.grandTotal.toFixed(2)}  —  Kindly clear this payment at your earliest convenience.`,
           PAD + 14, y + 22, { width: PW - PAD * 2 - 20 }
         );
      y += noticeH + 12;
    }

    // ── Notes / thank you block ────────────────────────────────────────────
    const noteY = PH - 80;
    doc.moveTo(PAD, noteY).lineTo(PW - PAD, noteY).strokeColor(GREEN_CHIP).lineWidth(1).stroke();
    doc.fillColor(GREEN_MID).fontSize(10).font('Helvetica-Bold')
       .text(`Thank you for shopping at ${storeName}! 🌾`, PAD, noteY + 10, { align: 'center', width: PW - PAD * 2 });
    doc.fillColor(SLATE_LIGHT).fontSize(7.5).font('Helvetica')
       .text('This is a computer-generated invoice. No signature required.', PAD, noteY + 26, { align: 'center', width: PW - PAD * 2 });

    // Bottom accent bar
    doc.rect(0, PH - 6, PW, 6).fill(GREEN_MID);

    doc.end();
  } catch (error: any) {
    res.status(500).send('Error generating invoice PDF: ' + error.message);
  }
});

export default router;
