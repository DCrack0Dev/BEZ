// API Layer - Handles all HTTP endpoints
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import http from 'http';
import { apiLogger, logger } from '../logging';

const router = express.Router();

// Apply CORS and body parser to router
router.use(cors());
router.use(bodyParser.json({ limit: '50mb' }));
router.use(bodyParser.urlencoded({ extended: true }));

// Health check endpoint
router.get('/test', (req, res) => {
  apiLogger.info('Health check requested');
  res.status(200).send('OK');
});

// Export router and helper to attach to app
export const apiRouter = router;

export const attachAPI = (app: express.Application) => {
  app.use('/', apiRouter);
  apiLogger.info('API layer attached');
};
