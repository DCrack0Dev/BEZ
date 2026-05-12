import { Server } from 'socket.io';
import { TradeSignal } from './signalValidator';

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
 * Emits a new validated trade signal to all connected mobile apps.
 */
export const emitSignal = (signal: TradeSignal) => {
  if (!io) return;

  console.log(`[WS] 🚀 Emitting new signal for ${signal.symbol}`);
  io.emit('TRADE_SIGNAL', {
    signal,
    urgency: 'HIGH',
    expiresIn: 30,
    requiresConfirmation: false
  });
};

/**
 * Emits a trailing stop update for a specific position.
 */
export const emitStopUpdate = (positionTicket: string, newStopLoss: number, phase: number, isRiskFree: boolean) => {
  if (!io) return;

  console.log(`[WS] 🛡️ Emitting stop update for #${positionTicket} -> ${newStopLoss}`);
  io.emit('STOP_UPDATE', {
    positionTicket,
    newStopLoss,
    phase,
    isRiskFree
  });
};

/**
 * Emits a scale-in trigger notification.
 */
export const emitScaleInTrigger = (signalId: string, level: number, price: number, lotSize: number, newStopLoss: number) => {
  if (!io) return;

  console.log(`[WS] ➕ Emitting scale-in trigger for ${signalId} Level ${level}`);
  io.emit('SCALEIN_TRIGGER', {
    signalId,
    level,
    price,
    lotSize,
    newStopLoss
  });
};
