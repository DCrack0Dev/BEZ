import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, setBotConfig } from '../api/orders';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLogStore } from '../store/useLogStore';
import { useAuthStore } from '../store/useAuthStore';

function setupProgressEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.overallProgress !== b.overallProgress) return false;
  if (a.session !== b.session) return false;
  if (a.summary !== b.summary) return false;
  if (a.tradeType !== b.tradeType) return false;
  if (a.bias !== b.bias) return false;
  if (a.blockers?.length !== b.blockers?.length) return false;
  if (a.hardGates?.length !== b.hardGates?.length) return false;
  if (a.buyGates?.length !== b.buyGates?.length) return false;
  if (a.sellGates?.length !== b.sellGates?.length) return false;
  return true;
}

function accountsShallowEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const va = a[k];
    const vb = b[k];
    if (k === 'setupProgress') {
      if (!setupProgressEqual(va, vb)) return false;
      continue;
    }
    if (typeof va === 'number' && typeof vb === 'number') {
      if (Math.abs(va - vb) >= 0.0001 && Object.is(va, vb) === false) return false;
      if (k === 'spread' ? Math.abs(va - vb) >= 0.5 : Math.abs(va - vb) >= 0.01) return false;
      continue;
    }
    if (va !== vb) return false;
  }
  return true;
}

function positionsShallowEqual(a: any[], b: any[] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (pa.ticket !== pb.ticket) return false;
    if (pa.type !== pb.type) return false;
    if (pa.symbol !== pb.symbol) return false;
    if (Math.abs(Number(pa.lots || 0) - Number(pb.lots || 0)) > 0.0001) return false;
    if (Math.abs(Number(pa.openPrice || 0) - Number(pb.openPrice || 0)) > 0.0001) return false;
    if (Math.abs(Number(pa.currentPrice || 0) - Number(pb.currentPrice || 0)) > 0.01) return false;
    if (Math.abs(Number(pa.profit || 0) - Number(pb.profit || 0)) > 0.01) return false;
  }
  return true;
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
  const prevAccountSnapshot = useRef<any>(null);
  const prevSetupSnapshot = useRef<any>(null);
  const prevSignalReason = useRef<string>('');
  const prevPositionsSnapshot = useRef<any[] | null>(null);
  const lastRefreshAt = useRef<number>(0);
  const lastAccountPriceAt = useRef<{ price: number; t: number }>({ price: 0, t: 0 });
  const lastConfigSyncAt = useRef<number>(0);

  // Stable refs for refresh + settings so socket never teardowns on identity change.
  // This is the #1 cause of "lag" — every botSettings mutation used to change refresh
  // identity which caused socket useEffect to teardown + reconnect (800ms RTT on reconnect
  // plus 2+ seconds of stale data, repeated every time user toggled auto/ai/timezone).
  const refreshRef = useRef<(showLoading?: boolean) => Promise<void>>(async () => {});
  const botSettingsRef = useRef(botSettings);
  useEffect(() => {
    botSettingsRef.current = botSettings;
  }, [botSettings]);

  useEffect(() => {
    const url = serverUrl || 'https://liquibot-back.onrender.com';
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
      if (data.price != null) {
        const prev = lastAccountPriceAt.current;
        const price = Number(data.price || 0);
        const now = Date.now();
        const meaningfulDelta = data.symbol === 'XAUUSD' || !data.symbol
          ? Math.abs(prev.price - price) >= 0.05
          : Math.abs(prev.price - price) >= 0.00005;
        const stale = now - prev.t >= 250;
        if (meaningfulDelta || stale) {
          lastAccountPriceAt.current = { price, t: now };
          setAccountPrice(price);
        }
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
      if (!accountsShallowEqual(prevAccountSnapshot.current, accountSnapshot)) {
        prevAccountSnapshot.current = accountSnapshot;
        setAccount(accountSnapshot);
      }

      if (data.setupProgress && !setupProgressEqual(prevSetupSnapshot.current, data.setupProgress)) {
        prevSetupSnapshot.current = data.setupProgress;
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
      if (!positionsShallowEqual(prevPositionsSnapshot.current, openPositions)) {
        prevPositionsSnapshot.current = openPositions;
        setOpenPositions(openPositions);
      }

      if (data.lastSignalReason) {
        if (prevSignalReason.current !== data.lastSignalReason) {
          prevSignalReason.current = data.lastSignalReason;
          setLastSignalReason(data.lastSignalReason);
        }
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
      if (data?.price != null) {
        const prev = lastAccountPriceAt.current;
        const price = Number(data.price || 0);
        const now = Date.now();
        const meaningfulDelta = Math.abs(prev.price - price) >= 0.05;
        const stale = now - prev.t >= 250;
        if (meaningfulDelta || stale) {
          lastAccountPriceAt.current = { price, t: now };
          setAccountPrice(price);
        }
      }

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
        if (!positionsShallowEqual(prevPositionsSnapshot.current, openPositions)) {
          prevPositionsSnapshot.current = openPositions;
          setOpenPositions(openPositions);
        }
      }

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
      refreshRef.current(false);
    });

    socketRef.current.on('TRADE_CLOSED', (data: any) => {
      const pnl = Number(data?.profit ?? data?.pnl ?? 0);
      addLog({
        component: 'MT5',
        level: pnl >= 0 ? 'success' : 'warning',
        message: `CLOSED #${data?.ticket ?? '?'} · ${pnl >= 0 ? 'WIN' : 'LOSS'} ${pnl.toFixed(2)}`,
      } as any);
      refreshRef.current(false);
    });

    return () => {
      socketRef.current?.disconnect();
    };
    // NOTE: intentionally minimal deps. Everything changing is read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  const refresh = useCallback(
    async (showLoading = false) => {
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
        if (!accountsShallowEqual(prevAccountSnapshot.current, accountSnapshot)) {
          prevAccountSnapshot.current = accountSnapshot;
          setAccount(accountSnapshot);
        }

        if (accountData.setupProgress && !setupProgressEqual(prevSetupSnapshot.current, accountData.setupProgress)) {
          prevSetupSnapshot.current = accountData.setupProgress;
          setSetupProgress(accountData.setupProgress);
        }
        if (accountData.lastSignalReason && prevSignalReason.current !== accountData.lastSignalReason) {
          prevSignalReason.current = accountData.lastSignalReason;
          setLastSignalReason(accountData.lastSignalReason);
        }

        const price = Number(accountData.price || 0);
        const prev = lastAccountPriceAt.current;
        if (Math.abs(prev.price - price) >= 0.05 || now - prev.t >= 250) {
          lastAccountPriceAt.current = { price, t: now };
          setAccountPrice(price);
        }

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
        if (!positionsShallowEqual(prevPositionsSnapshot.current, openPositions)) {
          prevPositionsSnapshot.current = openPositions;
          setOpenPositions(openPositions);
        }

        const settings = botSettingsRef.current;
        const tzEnabled = settings.timezoneTradingEnabled !== false;
        const maxSpread = settings.maxSpreadPoints ?? 800;
        const configStale = now - lastConfigSyncAt.current > 5000;
        if (
          accountData.ea_connected &&
          configStale &&
          (prevAutoTrading.current !== settings.autoTradingEnabled ||
            prevAiTrading.current !== settings.aiTradingEnabled ||
            prevTimezone.current !== tzEnabled ||
            prevMaxSpread.current !== maxSpread)
        ) {
          lastConfigSyncAt.current = now;
          prevAutoTrading.current = settings.autoTradingEnabled;
          prevAiTrading.current = settings.aiTradingEnabled;
          prevTimezone.current = tzEnabled;
          prevMaxSpread.current = maxSpread;
          await setBotConfig({
            autoTradingEnabled: settings.autoTradingEnabled,
            aiTradingEnabled: settings.aiTradingEnabled,
            timezoneTradingEnabled: tzEnabled,
            maxSpreadPoints: maxSpread,
          });
          addLog({
            component: 'App',
            level: 'info',
            message: `Config synced · auto=${settings.autoTradingEnabled ? 'ON' : 'OFF'} · ai=${settings.aiTradingEnabled ? 'ON' : 'OFF'} · timezone=${tzEnabled ? 'ON' : 'OFF'} · maxSpread=${maxSpread}pts`,
          } as any);
        }

        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Refresh failed');
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    // NOTE: store setters are stable (zustand create function references).
    // Settings read via botSettingsRef; log via addLog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      setAccount,
      setAccountPrice,
      setOpenPositions,
      setError,
      setLoading,
      setSetupProgress,
      setLastSignalReason,
      addLog,
    ]
  );

  // Keep refresh ref in sync so socket events can call latest version without reconnect.
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
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
