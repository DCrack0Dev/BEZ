import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { TradingGateway } from './trading.gateway';
import { TradingModeResponseDto, UpdateTradingModeDto } from './trading.dto';
import { TradingService } from './trading.service';
import {
  Mt5ExecutionResultPlaceholder,
  Mt5PollResponsePlaceholder,
  Mt5SignalPayloadPlaceholder,
  SignalStatus,
} from './trading.types';

type AuthenticatedRequest = Request & { user: { sub: string } };

@Controller('trading')
export class TradingController {
  constructor(
    private readonly tradingService: TradingService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly tradingGateway: TradingGateway,
  ) {}

  /**
   * Updates trading mode between LOCAL and BACKEND.
   */
  @UseGuards(AuthGuard('jwt'))
  @Patch('mode')
  async updateMode(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateTradingModeDto,
  ): Promise<TradingModeResponseDto> {
    return this.tradingService.updateMode(req.user.sub, dto);
  }

  /**
   * Returns current trading mode and backend job status.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('mode')
  async getMode(@Req() req: AuthenticatedRequest): Promise<TradingModeResponseDto> {
    return this.tradingService.getMode(req.user.sub);
  }

  /**
   * TODO: Confirm this path matches your .mph file exactly.
   * TODO: MT5 polling endpoint placeholder.
   */
  @Get('__TODO_MT5_POLLING_PATH__')
  async pollPendingSignal(
    @Headers('x-api-key') apiKey?: string,
  ): Promise<Mt5PollResponsePlaceholder | null> {
    this.validateMt5ApiKeyIfEnabled(apiKey);

    const pendingSignal = await this.prisma.signal.findFirst({
      where: { status: SignalStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
    if (!pendingSignal) return null;

    await this.prisma.signal.update({
      where: { id: pendingSignal.id },
      data: { status: SignalStatus.SENT },
    });

    const responsePayload: Mt5SignalPayloadPlaceholder = {};
    return responsePayload as Mt5PollResponsePlaceholder;
  }

  /**
   * TODO: Confirm this path matches your .mph file exactly.
   * TODO: MT5 execution callback placeholder.
   */
  @Post('__TODO_MT5_EXECUTION_CALLBACK_PATH__')
  async receiveExecutionResult(
    @Headers('x-api-key') apiKey: string | undefined,
    @Body() body: Mt5ExecutionResultPlaceholder,
  ): Promise<{ ok: true }> {
    this.validateMt5ApiKeyIfEnabled(apiKey);

    const payload = body as Record<string, unknown>;
    // TODO: replace placeholder keys using the exact names from your .mph callback payload.
    const signalId = payload['<MT5_SIGNAL_ID_FIELD_PLACEHOLDER>'];
    const executionSucceeded = payload['<MT5_EXECUTION_SUCCESS_FIELD_PLACEHOLDER>'];

    if (typeof signalId !== 'string') {
      throw new BadRequestException('Missing MT5 signal id placeholder field in callback payload');
    }

    const updated = await this.prisma.signal.update({
      where: { id: signalId },
      data: {
        status: executionSucceeded === true ? SignalStatus.EXECUTED : SignalStatus.FAILED,
        executedAt: new Date(),
        executionResult: payload,
      },
    });

    const eventName = executionSucceeded === true ? 'trade.executed' : 'trade.failed';
    this.tradingGateway.emitToUser(updated.userId, eventName, payload);
    return { ok: true };
  }

  private validateMt5ApiKeyIfEnabled(apiKey?: string): void {
    const configured = this.configService.get<string>('MT5_BRIDGE_API_KEY');
    if (!configured) return;
    if (!apiKey || apiKey !== configured) {
      throw new UnauthorizedException('Invalid MT5 bridge API key');
    }
  }
}
