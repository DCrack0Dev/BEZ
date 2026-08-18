import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, setBotConfig } from '../api/orders';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLogStore } from '../store/useLogStore';
import { useAuthStore } from '../store/useAuthStore';

/**
 * usePolling.ts (UI Only)
 * Mobile app hook to update UI based on backend WebSocket heartbeats.
 */

export const usePolling = () => {
  const {
    setAccount,
    setAccountPrice,
    setOpenPositions,
    setError,
    setLoading,
    setLastSignalReason,
    setSetupProgress,
  } = useTradeStore();
  const { botSettings, updateBotSettings } = useSettingsStore();
  const { addLog } = useLogStore();
  const { serverUrl } = useAuthStore();

  const socketRef = useRef<Socket | null>(null);
  const prevAutoTrading = useRef<boolean>(botSettings.autoTradingEnabled);
  const prevAiTrading = useRef<boolean>(botSettings.aiTradingEnabled);
  const prevTimezone = useRef<boolean>(botSettings.timezoneTradingEnabled !== false);
  const prevMaxSpread = useRef<number>(botSettings.maxSpreadPoints ?? 800);
  const lastSetupLog = useRef<string>('');

  useEffect(() => {
    const url = serverUrl || 'https://liquibot-back.onrender.com';
    socketRef.current = io(url);

    socketRef.current.on('EA_HEARTBEAT', (data) => {
      if (data.price) {
        setAccountPrice(Number(data.price));
      }

      setAccount({
        ...data,
        eaConnected: data.ea_connected,
        eaSymbol: data.symbol || 'XAUUSD',
        currency: data.currency || 'USD',
        price: Number(data.price || 0),
        equity: Number(data.equity || data.account_equity || 0),
        balance: Number(data.balance || data.account_balance || 0),
        pnlToday: Number(data.pnl_today || data.pnlToday || 0),
        fastEMA: Number(data.ema20 || 0),
        slowEMA: Number(data.ema50 || 0),
        atr: Number(data.atr14 || 0),
        spread: Number(data.spread || 0),
        setupProgress: data.setupProgress || null,
        timezoneTradingEnabled: data.timezoneTradingEnabled,
        autoTradingEnabled: data.autoTradingEnabled,
        aiTradingEnabled: data.aiTradingEnabled,
      });

      if (data.setupProgress) {
        setSetupProgress(data.setupProgress);
      }

      const openPositions = (data.positions || []).map((p: any) => ({
        ticket: String(p.ticket),
        symbol: p.symbol,
        type: p.type,
        lots: p.volume || p.lots || 0,
        openPrice: p.openPrice || p.price || 0,
        currentPrice: data.price || p.price || 0,
        profit: Number(p.profit || p.pnl || 0),
        pnl: Number(p.profit || p.pnl || 0),
        openTime: p.time ? new Date(Number(p.time) * 1000).toISOString() : new Date().toISOString(),
      }));
      setOpenPositions(openPositions);

      if (data.lastSignalReason) {
        setLastSignalReason(data.lastSignalReason);
        // Throttle terminal spam: log when summary changes (heartbeat = setup update)
        if (data.lastSignalReason !== lastSetupLog.current) {
          lastSetupLog.current = data.lastSignalReason;
          const ready = data.setupProgress?.overallProgress >= 100;
          addLog({
            component: 'Backend',
            level: ready ? 'success' : 'info',
            message: data.lastSignalReason,
            details: data.setupProgress?.blockers?.length
              ? `Need: ${data.setupProgress.blockers.slice(0, 3).join(' · ')}`
              : undefined,
          } as any);
        }
      }
    });

    socketRef.current.on('TRADE_SIGNAL', (data) => {
      addLog({
        component: 'Backend',
        level: 'success',
        message: `SIGNAL: ${data.signal?.direction || 'UNKNOWN'} ${data.signal?.symbol || 'XAUUSD'}`,
      } as any);
    });

    socketRef.current.on('STOP_UPDATE', (data) => {
      addLog({
        component: 'Backend',
        level: 'info',
        message: `TS Update: #${data.positionTicket} → SL ${data.newStopLoss} (Phase ${data.phase})`,
      } as any);
    });

    socketRef.current.on('BOT_CONFIG', (data) => {
      if (typeof data.timezoneTradingEnabled === 'boolean') {
        updateBotSettings({ timezoneTradingEnabled: data.timezoneTradingEnabled });
        prevTimezone.current = data.timezoneTradingEnabled;
      }
      if (typeof data.autoTradingEnabled === 'boolean') {
        updateBotSettings({ autoTradingEnabled: data.autoTradingEnabled });
        prevAutoTrading.current = data.autoTradingEnabled;
      }
      if (typeof data.aiTradingEnabled === 'boolean') {
        updateBotSettings({ aiTradingEnabled: data.aiTradingEnabled });
        prevAiTrading.current = data.aiTradingEnabled;
      }
    });

    socketRef.current.on('EA_HEARTBEAT_QUICK', (data: any) => {
      if (data?.price != null) setAccountPrice(Number(data.price));
      if (data?.positions) {
        const openPositions = (data.positions || []).map((p: any) => ({
          ticket: String(p.ticket),
          symbol: p.symbol,
          type: p.type,
          lots: p.volume || p.lots || 0,
          openPrice: p.openPrice || p.price || 0,
          currentPrice: data.price || p.price || 0,
          profit: Number(p.profit || p.pnl || 0),
          pnl: Number(p.profit || p.pnl || 0),
          openTime: p.time ? new Date(Number(p.time) * 1000).toISOString() : new Date().toISOString(),
        }));
        setOpenPositions(openPositions);
      }
      if (data?.equity != null || data?.balance != null) {
        setAccount(prev => ({
          ...prev,
          equity: data.equity != null ? Number(data.equity) : prev.equity,
          balance: data.balance != null ? Number(data.balance) : prev.balance,
          spread: data.spread != null ? Number(data.spread) : prev.spread,
          eaConnected: data.ea_connected != null ? data.ea_connected : prev.eaConnected,
          autoTradingEnabled: data.autoTradingEnabled != null ? data.autoTradingEnabled : prev.autoTradingEnabled,
          aiTradingEnabled: data.aiTradingEnabled != null ? data.aiTradingEnabled : prev.aiTradingEnabled,
        }));
      }
    });

    socketRef.current.on('TRADE_OPENED', (data: any) => {
      addLog({
        component: 'MT5',
        level: 'success',
        message: `OPENED #${data?.ticket ?? '?'} · ${data?.direction ?? '?'} ${data?.symbol ?? 'XAUUSD'} @ ${data?.entryPrice ?? '?'}`,
        details: data?.confidence != null
          ? `SL ${data?.sl ?? '?'} · TP ${data?.tp ?? '?'} · ${(Number(data.confidence) * 100).toFixed(0)}% conf`
          : undefined,
      } as any);
      refresh(false);
    });

    socketRef.current.on('TRADE_CLOSED', (data: any) => {
      const pnl = Number(data?.profit ?? data?.pnl ?? 0);
      addLog({
        component: 'MT5',
        level: pnl >= 0 ? 'success' : 'warning',
        message: `CLOSED #${data?.ticket ?? '?'} · ${pnl >= 0 ? 'WIN' : 'LOSS'} ${pnl.toFixed(2)}`,
      } as any);
      refresh(false);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [
    serverUrl,
    setAccountPrice,
    setAccount,
    setOpenPositions,
    setLastSignalReason,
    setSetupProgress,
    addLog,
    updateBotSettings,
    refresh,
  ]);

  const refresh = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        const accountData = await getAccountData();
        if (!accountData) return;

        setAccount({
          ...accountData,
          eaConnected: accountData.ea_connected,
          eaSymbol: accountData.symbol || 'XAUUSD',
          currency: accountData.currency || 'USD',
          price: Number(accountData.price || 0),
          equity: Number(accountData.equity || accountData.account_equity || 0),
          balance: Number(accountData.balance || accountData.account_balance || 0),
          pnlToday: Number(accountData.pnl_today || accountData.pnlToday || 0),
          fastEMA: Number(accountData.ema20 || 0),
          slowEMA: Number(accountData.ema50 || 0),
          atr: Number(accountData.atr14 || 0),
          spread: Number(accountData.spread || 0),
          setupProgress: accountData.setupProgress || null,
          timezoneTradingEnabled: accountData.timezoneTradingEnabled,
          autoTradingEnabled: accountData.autoTradingEnabled,
          aiTradingEnabled: accountData.aiTradingEnabled,
        });

        if (accountData.setupProgress) {
          setSetupProgress(accountData.setupProgress);
        }
        if (accountData.lastSignalReason) {
          setLastSignalReason(accountData.lastSignalReason);
        }

        setAccountPrice(Number(accountData.price || 0));

        const openPositions = (accountData.positions || []).map((p: any) => ({
          ticket: String(p.ticket),
          symbol: p.symbol,
          type: p.type,
          lots: p.volume || p.lots || 0,
          openPrice: p.openPrice || p.price || 0,
          currentPrice: accountData.price || p.price || 0,
          profit: Number(p.profit || p.pnl || 0),
          pnl: Number(p.profit || p.pnl || 0),
          openTime: p.time
            ? new Date(Number(p.time) * 1000).toISOString()
            : new Date().toISOString(),
        }));
        setOpenPositions(openPositions);

        const tzEnabled = botSettings.timezoneTradingEnabled !== false;
        const maxSpread = botSettings.maxSpreadPoints ?? 800;
        if (
          accountData.ea_connected &&
          (prevAutoTrading.current !== botSettings.autoTradingEnabled ||
            prevAiTrading.current !== botSettings.aiTradingEnabled ||
            prevTimezone.current !== tzEnabled ||
            prevMaxSpread.current !== maxSpread)
        ) {
          prevAutoTrading.current = botSettings.autoTradingEnabled;
          prevAiTrading.current = botSettings.aiTradingEnabled;
          prevTimezone.current = tzEnabled;
          prevMaxSpread.current = maxSpread;
          await setBotConfig({
            autoTradingEnabled: botSettings.autoTradingEnabled,
            aiTradingEnabled: botSettings.aiTradingEnabled,
            timezoneTradingEnabled: tzEnabled,
            maxSpreadPoints: maxSpread,
          });
          addLog({
            component: 'App',
            level: 'info',
            message: `Config synced · auto=${botSettings.autoTradingEnabled ? 'ON' : 'OFF'} · ai=${botSettings.aiTradingEnabled ? 'ON' : 'OFF'} · timezone=${tzEnabled ? 'ON' : 'OFF'} · maxSpread=${maxSpread}pts`,
          } as any);
        }

        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Refresh failed');
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [
      setAccount,
      setAccountPrice,
      setOpenPositions,
      setError,
      setLoading,
      setSetupProgress,
      setLastSignalReason,
      botSettings,
      addLog,
    ]
  );

  useEffect(() => {
    refresh(true);
    const interval = setInterval(() => {
      refresh(false);
    }, 2500);
    return () => clearInterval(interval);
  }, [refresh]);

  const setTimezoneTrading = useCallback(
    async (enabled: boolean) => {
      await updateBotSettings({ timezoneTradingEnabled: enabled });
      prevTimezone.current = enabled;
      try {
        await setBotConfig({ timezoneTradingEnabled: enabled });
        addLog({
          component: 'App',
          level: 'info',
          message: enabled
            ? 'Timezone trading ON — Asia session blocked'
            : 'Timezone trading OFF — any session allowed',
        } as any);
      } catch (err) {
        addLog({
          component: 'App',
          level: 'error',
          message: `Failed to sync timezone setting: ${err instanceof Error ? err.message : String(err)}`,
        } as any);
      }
    },
    [updateBotSettings, addLog]
  );

  return { refresh, setTimezoneTrading };
};
