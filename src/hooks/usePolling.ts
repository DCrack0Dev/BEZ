import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, setBotConfig } from '../api/orders';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLogStore } from '../store/useLogStore';
import { useAuthStore } from '../store/useAuthStore';

function shallowJsonEqual<T>(a: T, b: T): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

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
  // Shallow-compare refs to avoid duplicate setState and laggy re-renders
  const prevAccountSnapshot = useRef<any>(null);
  const prevPositionsSnapshot = useRef<any[] | null>(null);
  const lastRefreshAt = useRef<number>(0);

  useEffect(() => {
    const url = serverUrl || 'https://liquibot-back.onrender.com';
    // Force WebSocket first + upgrades disabled for zero-latency.
    // (No long-polling handshake, which was adding 300-800ms RTT delays.)
    socketRef.current = io(url, {
      transports: ['websocket'],
      upgrade: false,
      perMessageDeflate: { threshold: 128 },
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
      randomizationFactor: 0.25,
      timeout: 8000,
    });

    socketRef.current.on('EA_HEARTBEAT', (data) => {
      if (data.price) {
        setAccountPrice(Number(data.price));
      }

      const accountSnapshot = {
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
      };
      if (!shallowJsonEqual(prevAccountSnapshot.current, accountSnapshot)) {
        prevAccountSnapshot.current = accountSnapshot;
        setAccount(accountSnapshot);
      }

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
      if (!shallowJsonEqual(prevPositionsSnapshot.current, openPositions)) {
        prevPositionsSnapshot.current = openPositions;
        setOpenPositions(openPositions);
      }

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
      // Price updates every tick — cheap, always allowed
      if (data?.price != null) setAccountPrice(Number(data.price));

      // Position updates: only commit to state if positions array content changed
      if (data?.positions && Array.isArray(data.positions)) {
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
        if (!shallowJsonEqual(prevPositionsSnapshot.current, openPositions)) {
          prevPositionsSnapshot.current = openPositions;
          setOpenPositions(openPositions);
        }
      }

      // Account fields: batch equity/balance/spread — only set if any meaningful number changed
      if (data?.equity != null || data?.balance != null || data?.spread != null || data?.autoTradingEnabled != null) {
        setAccount(prev => {
          const next: any = { ...prev };
          let changed = false;
          if (data.equity != null) {
            const num = Number(data.equity);
            if (Math.abs((prev.equity || 0) - num) >= 0.01) { next.equity = num; changed = true; }
          }
          if (data.balance != null) {
            const num = Number(data.balance);
            if (Math.abs((prev.balance || 0) - num) >= 0.01) { next.balance = num; changed = true; }
          }
          if (data.spread != null) {
            const num = Number(data.spread);
            if (Math.abs((prev.spread || 0) - num) >= 0.5) { next.spread = num; changed = true; }
          }
          if (data.ea_connected != null && prev.eaConnected !== !!data.ea_connected) {
            next.eaConnected = !!data.ea_connected;
            changed = true;
          }
          if (data.autoTradingEnabled != null && prev.autoTradingEnabled !== !!data.autoTradingEnabled) {
            next.autoTradingEnabled = !!data.autoTradingEnabled;
            changed = true;
          }
          if (data.aiTradingEnabled != null && prev.aiTradingEnabled !== !!data.aiTradingEnabled) {
            next.aiTradingEnabled = !!data.aiTradingEnabled;
            changed = true;
          }
          return changed ? next : prev;
        });
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
      // Throttle: don't allow more than one refresh every 1200ms
      const now = Date.now();
      if (!showLoading && now - lastRefreshAt.current < 1200) {
        return;
      }
      lastRefreshAt.current = now;
      if (showLoading) setLoading(true);
      try {
        const accountData = await getAccountData();
        if (!accountData) return;

        const accountSnapshot = {
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
        };
        if (!shallowJsonEqual(prevAccountSnapshot.current, accountSnapshot)) {
          prevAccountSnapshot.current = accountSnapshot;
          setAccount(accountSnapshot);
        }

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
        if (!shallowJsonEqual(prevPositionsSnapshot.current, openPositions)) {
          prevPositionsSnapshot.current = openPositions;
          setOpenPositions(openPositions);
        }

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
    // Initial load only — after that we rely 100% on realtime WebSocket
    // EA_HEARTBEAT_QUICK + EA_HEARTBEAT events for perfect sync.
    // No more stale 2/6-second HTTP polling gaps where MT5 equity moves
    // before the app refreshes!
    refresh(true);
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
