import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';

const router = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'Admin authentication required' });
    return false;
  }

  const AdminSession = mongoose.model('AdminSession');
  const AdminDevice = mongoose.model('AdminDevice');

  const session = await AdminSession.findOne({
    token,
    expiresAt: { $gt: new Date().toISOString() },
  })
    .lean<{ deviceId: string }>()
    .exec();

  if (!session) {
    res.status(401).json({ error: 'Admin session expired' });
    return false;
  }

  const device = await AdminDevice.findOne({ deviceId: session.deviceId, active: true }).lean().exec();
  if (!device) {
    res.status(401).json({ error: 'Admin session expired' });
    return false;
  }

  return true;
}

export { requireAdmin };

router.get('/store', async (_req: Request, res: Response) => {
  try {
    const Setting = mongoose.model('Setting');
    const rows = await Setting.find({}).lean().exec();
    res.json(Object.fromEntries(rows.map(row => [row._id, row.value])));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

async function createSession(deviceId: string, res: Response) {
  const AdminSession = mongoose.model('AdminSession');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

  await AdminSession.create({ token, expiresAt, deviceId });
  res.json({ token, expiresAt });
}

router.post('/device-login', async (req: Request, res: Response) => {
  const { deviceId } = req.body;
  if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'Device ID is required' });

  const AdminDevice = mongoose.model('AdminDevice');
  const device = await AdminDevice.findOne({ deviceId, active: true }).lean().exec();
  if (!device) return res.status(403).json({ error: 'This device is not approved' });

  await createSession(deviceId, res);
});

router.post('/recovery-claim', async (req: Request, res: Response) => {
  const { deviceId, name, phone, recoveryKey } = req.body;
  if (!process.env.MASTER_RECOVERY_KEY || recoveryKey !== process.env.MASTER_RECOVERY_KEY)
    return res.status(401).json({ error: 'Invalid recovery key' });
  if (!deviceId || !name) return res.status(400).json({ error: 'Device ID and name are required' });

  const AdminDevice = mongoose.model('AdminDevice');
  await AdminDevice.updateOne(
    { deviceId },
    { deviceId, name, phone: phone || undefined, active: true, createdAt: new Date().toISOString() },
    { upsert: true }
  ).exec();

  await createSession(deviceId, res);
});

router.get('/admins', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const AdminDevice = mongoose.model('AdminDevice');
  const admins = await AdminDevice.find({ active: true }).sort({ createdAt: 1 }).lean().exec();
  res.json(admins);
});

router.post('/admins', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  const { deviceId, name, phone } = req.body;
  if (!deviceId || !name) return res.status(400).json({ error: 'Device ID and name are required' });

  const AdminDevice = mongoose.model('AdminDevice');
  await AdminDevice.updateOne(
    { deviceId },
    { deviceId, name, phone: phone || undefined, active: true, createdAt: new Date().toISOString() },
    { upsert: true }
  ).exec();

  res.status(201).json({ message: 'Owner device approved' });
});

router.delete('/admins/:deviceId', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const AdminDevice = mongoose.model('AdminDevice');
  const AdminSession = mongoose.model('AdminSession');
  await AdminDevice.updateOne({ deviceId: req.params.deviceId }, { active: false }).exec();
  await AdminSession.deleteMany({ deviceId: req.params.deviceId }).exec();
  res.json({ message: 'Owner device revoked' });
});

router.put('/store', async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;

  const allowed = ['store_name', 'store_whatsapp', 'store_phone', 'store_address', 'store_hours', 'currency', 'low_stock_threshold'];
  const Setting = mongoose.model('Setting');

  for (const key of allowed) {
    if (typeof req.body[key] === 'string') {
      await Setting.updateOne({ _id: key }, { value: req.body[key].trim() }, { upsert: true }).exec();
    }
  }

  res.json({ message: 'Store settings updated' });
});

export default router;
