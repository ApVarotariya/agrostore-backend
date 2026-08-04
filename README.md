# AgroStore Backend

This backend runs on Node.js + TypeScript with Express and MongoDB Atlas.

## Setup

1. Copy `.env.example` to `.env`
2. Set `MONGODB_URI` to your Atlas connection URI.
3. Set `MONGODB_DB` to the database name.
4. Set `MASTER_RECOVERY_KEY` to a strong secret.

## Local development

```bash
cd backend
npm install
npm run dev
```

## Build and start

```bash
npm run build
npm start
```

## Render deployment

- Point the service to the backend directory.
- Set environment variables on Render:
  - `MONGODB_URI`
  - `MONGODB_DB`
  - `MASTER_RECOVERY_KEY`
  - `PORT` (optional)
