import { Server } from 'socket.io';
import { TradeSignal } from './riskEngine';

/**
 * signalEmitter.ts
 * Manages WebSocket communication with the mobile app.
 * Emits signals, trailing stop updates, and scale-in triggers.
 */

let io: Server;

/**
 * Initializes the WebSocket server.
 * @param server - The HTTP server instance.
 */
export const initEmitter = (server: any) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log(`[WS] 📱 Mobile app connected: ${socket.id}`);
    
    socket.on('disconnect', () => {
      console.log(`[WS] 📱 Mobile app disconnected: ${socket.id}`);
    });
  });

  return io;
};

/**
 * JSDoc: Emits a new validated trade signal to all connected mobile apps.
 * @param signal - The TradeSignal object from riskEngine.
 */
export const emitSignal = (signal: TradeSignal) => {
  if (!io) return;

  const isXAUUSD = signal.symbol.includes("XAU") || signal.symbol.includes("GOLD");
  
  console.log(`[WS] 🚀 Emitting new signal for ${signal.symbol}`);
  io.emit('TRADE_SIGNAL', {
    signal,
    urgency: 'HIGH',
    expiresIn: signal.direction === 'BUY' ? 30 : (isXAUUSD ? 20 : 30),
    requiresConfirmation: false,
  });
};

/**
 * JSDoc: Emits a trailing stop update for a specific position.
 * @param payload - The update details.
 */
export const emitStopUpdate = (payload: {
  positionTicket: string;
  newStopLoss: number;
  phase: 1 | 2 | 3 | 4 | 5;
  isRiskFree: boolean;
  direction: 'BUY' | 'SELL';
}) => {
  if (!io) return;

  console.log(`[WS] 🛡️ Emitting stop update for #${payload.positionTicket} (Phase ${payload.phase})`);
  io.emit('STOP_UPDATE', payload);
};

/**
 * JSDoc: Emits a scale-in trigger notification.
 * @param payload - The scale-in details.
 */
export const emitScaleInTrigger = (payload: {
  signalId: string;
  level: 2 | 3;
  price: number;
  lotSize: number;
  newStopLoss: number;
  direction: 'BUY' | 'SELL';
}) => {
  if (!io) return;

  console.log(`[WS] ➕ Emitting scale-in trigger for ${payload.signalId} Level ${payload.level}`);
  io.emit('SCALEIN_TRIGGER', payload);
};
