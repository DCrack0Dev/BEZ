import React, { useState, useEffect } from 'react';
import { Calendar, TrendingUp, DollarSign, Clock, RefreshCw } from 'lucide-react';
import apiClient from '../api/client';

const ClientDashboard = () => {
  const [timeframe, setTimeframe] = useState('weekly');
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState({
    weekly: { profit: 0, trades: 0, winRate: '0%' },
    monthly: { profit: 0, trades: 0, winRate: '0%' },
    quarterly: { profit: 0, trades: 0, winRate: '0%' },
    yearly: { profit: 0, trades: 0, winRate: '0%' },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch real trade data from backend
  const fetchTradeData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Get account data including trades
      const response = await apiClient.get('/api/account');
      const accountData = response.data;
      
      // Process closed trades
      const closedTrades = accountData.trades || [];
      setTrades(closedTrades);
      
      // Calculate stats based on real trades
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const quarterAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      
      const calculateStats = (trades, startDate) => {
        const filteredTrades = trades.filter(trade => 
          new Date(trade.closeTime || trade.openTime) >= startDate
        );
        
        const totalProfit = filteredTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
        const winningTrades = filteredTrades.filter(trade => (trade.pnl || 0) > 0);
        const winRate = filteredTrades.length > 0 ? (winningTrades.length / filteredTrades.length * 100).toFixed(0) : '0';
        
        return {
          profit: totalProfit,
          trades: filteredTrades.length,
          winRate: `${winRate}%`
        };
      };
      
      setStats({
        weekly: calculateStats(closedTrades, weekAgo),
        monthly: calculateStats(closedTrades, monthAgo),
        quarterly: calculateStats(closedTrades, quarterAgo),
        yearly: calculateStats(closedTrades, yearAgo),
      });
      
    } catch (err) {
      console.error('Error fetching trade data:', err);
      setError('Failed to load trade data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTradeData();
    
    // Refresh data every 30 seconds
    const interval = setInterval(fetchTradeData, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
        <div>
          <h1 className="text-3xl font-bold">Trade Journal</h1>
          <p className="text-gray-400">Track and analyze your FxScalpKing performance</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={fetchTradeData}
            className="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary rounded-lg border border-primary/20 hover:bg-primary/20 transition"
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <div className="flex bg-accent p-1 rounded-xl border border-gray-800">
            {['weekly', 'monthly', 'quarterly', 'yearly'].map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold capitalize transition ${
                  timeframe === tf ? 'bg-primary text-black' : 'text-gray-400 hover:text-white'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <div className="bg-accent p-6 rounded-2xl border border-gray-800">
          <div className="flex justify-between items-center mb-4">
            <DollarSign className="text-primary" />
            <span className="text-xs text-gray-500 uppercase">Total Profit</span>
          </div>
          <div className="text-3xl font-bold text-primary">+${stats[timeframe].profit.toFixed(2)}</div>
        </div>
        <div className="bg-accent p-6 rounded-2xl border border-gray-800">
          <div className="flex justify-between items-center mb-4">
            <Clock className="text-primary" />
            <span className="text-xs text-gray-500 uppercase">Total Trades</span>
          </div>
          <div className="text-3xl font-bold">{stats[timeframe].trades}</div>
        </div>
        <div className="bg-accent p-6 rounded-2xl border border-gray-800">
          <div className="flex justify-between items-center mb-4">
            <TrendingUp className="text-primary" />
            <span className="text-xs text-gray-500 uppercase">Win Rate</span>
          </div>
          <div className="text-3xl font-bold">{stats[timeframe].winRate}</div>
        </div>
      </div>

      {/* Trade History */}
      <div className="bg-accent rounded-3xl border border-gray-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center">
          <h3 className="font-bold">Recent History</h3>
          <div className="flex items-center gap-2">
            {loading && <RefreshCw size={16} className="animate-spin text-gray-500" />}
            <Calendar size={18} className="text-gray-500" />
          </div>
        </div>
        
        {loading ? (
          <div className="p-8 text-center text-gray-400">
            <RefreshCw size={24} className="animate-spin mx-auto mb-2" />
            Loading trade data...
          </div>
        ) : trades.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            <Calendar size={24} className="mx-auto mb-2 opacity-50" />
            No trades found. Start trading to see your history here.
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-secondary/50 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-6 py-4">Symbol</th>
                <th className="px-6 py-4">Type</th>
                <th className="px-6 py-4">Pips</th>
                <th className="px-6 py-4">Profit</th>
                <th className="px-6 py-4 text-right">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {trades.map((trade) => (
                <tr key={trade.ticket} className="hover:bg-white/5 transition group">
                  <td className="px-6 py-4 font-bold">{trade.symbol || 'N/A'}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      trade.type === 'BUY' || trade.type === 0 ? 'bg-buy/10 text-buy' : 'bg-sell/10 text-sell'
                    }`}>
                      {trade.type === 'BUY' || trade.type === 0 ? 'BUY' : 'SELL'}
                    </span>
                  </td>
                  <td className={`px-6 py-4 ${(trade.pnl || 0) > 0 ? 'text-buy' : 'text-sell'}`}>
                    {trade.pips ? (trade.pips > 0 ? '+' : '') + trade.pips.toFixed(1) : 'N/A'}
                  </td>
                  <td className={`px-6 py-4 font-mono ${(trade.pnl || 0) > 0 ? 'text-buy' : 'text-sell'}`}>
                    {(trade.pnl || 0) > 0 ? '+' : ''}${Math.abs(trade.pnl || 0).toFixed(2)}
                  </td>
                  <td className="px-6 py-4 text-right text-gray-500 text-sm">
                    {trade.closeTime ? new Date(trade.closeTime).toLocaleDateString() : 
                     trade.openTime ? new Date(trade.openTime).toLocaleDateString() : 'N/A'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default ClientDashboard;
