import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import productRoutes from './routes/products';
import settingRoutes from './routes/settings';
import invoiceRoutes from './routes/invoices';
import categoryRoutes from './routes/categories';
import { connectMongo } from './db';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(cors());
app.use(express.json());

// Register API routes
app.use('/api/products', productRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/categories', categoryRoutes);

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

async function startServer() {
  try {
    await connectMongo();
    console.log('MongoDB initialized successfully.');

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database or start server:', error);
    process.exit(1);
  }
}

startServer();
