import {
  ConnectedSocket,
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';

@Injectable()
@WebSocketGateway({
  namespace: '/trading',
  cors: { origin: '*' },
})
export class TradingGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TradingGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handles socket handshake auth and joins user room.
   */
  handleConnection(@ConnectedSocket() client: Socket): void {
    try {
      const token = this.extractBearerToken(client.handshake.auth?.token ?? client.handshake.headers.authorization);
      if (!token) {
        client.disconnect();
        return;
      }

      const secret = this.configService.get<string>('JWT_SECRET');
      const payload = this.jwtService.verify(token, { secret });
      if (!payload?.sub) {
        client.disconnect();
        return;
      }

      client.join(this.userRoom(payload.sub));
    } catch (error) {
      this.logger.warn(`Socket auth failed: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  /**
   * Emits a websocket event to a single authenticated user room.
   */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.server.to(this.userRoom(userId)).emit(event, data);
  }

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private extractBearerToken(authHeaderOrToken?: string): string | null {
    if (!authHeaderOrToken) return null;
    if (authHeaderOrToken.startsWith('Bearer ')) {
      return authHeaderOrToken.slice('Bearer '.length).trim();
    }
    return authHeaderOrToken.trim();
  }
}

