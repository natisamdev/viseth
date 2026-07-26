import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { randomUUID } from 'crypto';
import { env } from './config/env';
import { errorHandler } from './middleware/error';
import configRoutes from './routes/config';
import meRoutes from './routes/me';
import catalogRoutes from './routes/catalog';
import paymentsRoutes from './routes/payments';
import socialRoutes from './routes/social';
import adminRoutes from './routes/admin';
import compatRoutes from './routes/compat';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Reflect any Origin (required for Flutter web on localhost → Render).
  app.use(
    cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'Accept',
        'X-Client',
        'Idempotency-Key',
        'X-Request-Id',
      ],
    }),
  );
  app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    req.requestId = (req.header('X-Request-Id') as string) || randomUUID();
    next();
  });

  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  const v1 = express.Router();
  v1.use(configRoutes);
  v1.use(meRoutes);
  v1.use(catalogRoutes);
  v1.use(paymentsRoutes);
  v1.use(socialRoutes);
  v1.use(adminRoutes);
  // Place-admin / customer integration guide path aliases
  v1.use(compatRoutes);

  app.use('/v1', v1);
  app.get('/', (_req, res) => {
    res.json({
      name: 'Viseth API',
      version: '1.0.0',
      docs: 'See customer guide and spec/VISETH_CLIENT_INTEGRATION_GUIDE.md',
      health: '/v1/health',
    });
  });

  app.use(errorHandler);
  return app;
}
