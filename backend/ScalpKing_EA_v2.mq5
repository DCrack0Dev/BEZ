//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v2.mq5 |
//|                                        Your Trading Bot Platform |
//|                     Scalper: Gold (XAU/USD) + Indices (US30/NAS) |
//|                    Strategy: Long & Short SMC Strategy           |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "2.15"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include "FxScalpKing_HTTP.mqh"

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input string   ApiKey            = "FXSK-90e36448c3d1ef9d749aa155ba228541";
input string   ServerURL         = "http://192.168.8.151:5000";
input int      MagicNumber       = 20260101;
input int      HeartbeatInterval = 1; // seconds
input int      StopLoss_Points   = 300;
input int      TakeProfit_Points = 600;

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade            trade;
CPositionInfo     posInfo;
bool              licenseValid      = false;
bool              isPaused          = false;
datetime          lastHeartbeat     = 0;
string            EA_Name           = "FxScalpKing EA v2.15";

// Indicators
int handle_ema20, handle_ema50, handle_atr;

//+------------------------------------------------------------------+
//| EXPERT INITIALIZATION                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("=== ", EA_Name, " Starting ===");
   
   FxScalpKing.SetServerUrl(ServerURL);
   FxScalpKing.SetApiKey(ApiKey);

   string expiry, plan;
   if(!FxScalpKing.ValidateLicense(expiry, plan))
   {
      Print("❌ License validation failed. Check API key or Server URL.");
      return INIT_FAILED;
   }
   
   licenseValid = true;
   trade.SetExpertMagicNumber(MagicNumber);
   
   handle_ema20 = iMA(_Symbol, PERIOD_M5, 20, 0, MODE_EMA, PRICE_CLOSE);
   handle_ema50 = iMA(_Symbol, PERIOD_M5, 50, 0, MODE_EMA, PRICE_CLOSE);
   handle_atr   = iATR(_Symbol, PERIOD_M5, 14);

   EventSetTimer(1);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(!licenseValid) return;
   
   if(TimeCurrent() - lastHeartbeat >= HeartbeatInterval)
   {
      SendHeartbeat();
      PollCommands();
      lastHeartbeat = TimeCurrent();
   }
}

void OnTick()
{
   // App Brain handles execution. MT5 just waits for BUY/SELL commands via Heartbeat
}

//+------------------------------------------------------------------+
//| HEARTBEAT LOGIC                                                 |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   double ema20[1], ema50[1], atr[1];
   CopyBuffer(handle_ema20, 0, 0, 1, ema20);
   CopyBuffer(handle_ema50, 0, 0, 1, ema50);
   CopyBuffer(handle_atr, 0, 0, 1, atr);

   string json = "{";
   json += "\"apiKey\":\"" + ApiKey + "\",";
   json += "\"symbol\":\"" + _Symbol + "\",";
   json += "\"price\":" + DoubleToString(tick.bid, _Digits) + ",";
   json += "\"spread\":" + DoubleToString((tick.ask - tick.bid)/_Point, 0) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"ema20\":" + DoubleToString(ema20[0], _Digits) + ",";
   json += "\"ema50\":" + DoubleToString(ema50[0], _Digits) + ",";
   json += "\"atr14\":" + DoubleToString(atr[0], _Digits) + ",";
   json += "\"isPaused\":" + (isPaused ? "true" : "false") + ",";
   
   // Positions
   json += "\"openPositions\":[";
   bool first = true;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
      {
         if(!first) json += ",";
         json += "{\"ticket\":" + IntegerToString(posInfo.Ticket()) + ",";
         json += "\"type\":\"" + (posInfo.PositionType()==POSITION_TYPE_BUY?"BUY":"SELL") + "\",";
         json += "\"lots\":" + DoubleToString(posInfo.Volume(), 2) + ",";
         json += "\"price\":" + DoubleToString(posInfo.PriceOpen(), _Digits) + ",";
         json += "\"profit\":" + DoubleToString(posInfo.Profit(), 2) + ",";
         json += "\"sl\":" + DoubleToString(posInfo.StopLoss(), _Digits) + ",";
         json += "\"tp\":" + DoubleToString(posInfo.TakeProfit(), _Digits) + "}";
         first = false;
      }
   }
   json += "],";
   
   // Send M5 candles
   json += "\"candles\":[";
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int lookback = 100; 
   if(CopyRates(_Symbol, PERIOD_M5, 0, lookback, rates) > 0)
   {
      for(int i=0; i<lookback; i++)
      {
         json += "{\"x\":" + IntegerToString(lookback - i) + ",";
         json += "\"open\":" + DoubleToString(rates[i].open, _Digits) + ",";
         json += "\"high\":" + DoubleToString(rates[i].high, _Digits) + ",";
         json += "\"low\":" + DoubleToString(rates[i].low, _Digits) + ",";
         json += "\"close\":" + DoubleToString(rates[i].close, _Digits) + ",";
         json += "\"timestamp\":" + IntegerToString(rates[i].time) + "}";
         if(i < lookback - 1) json += ",";
      }
   }
   json += "]}";

   string resp;
   FxScalpKing.SendHeartbeat(json, resp);
}

void PollCommands()
{
   string resp = FxScalpKing.GetCommands();
   if(resp == "" || resp == "[]") return;
   
   // The response is a JSON array of commands
   // We will look for BUY, SELL, PAUSE, RESUME, CLOSE_ALL
   if(StringFind(resp, "\"action\":\"BUY\"") >= 0 || StringFind(resp, "\"type\":\"BUY\"") >= 0) OpenBuy();
   if(StringFind(resp, "\"action\":\"SELL\"") >= 0 || StringFind(resp, "\"type\":\"SELL\"") >= 0) OpenSell();
   if(StringFind(resp, "\"action\":\"PAUSE\"") >= 0 || StringFind(resp, "\"type\":\"PAUSE\"") >= 0) { isPaused = true; Print("⏸ EA Paused"); }
   if(StringFind(resp, "\"action\":\"RESUME\"") >= 0 || StringFind(resp, "\"type\":\"RESUME\"") >= 0) { isPaused = false; Print("▶ EA Resumed"); }
   if(StringFind(resp, "\"action\":\"CLOSE_ALL\"") >= 0 || StringFind(resp, "\"type\":\"CLOSE_ALL\"") >= 0) CloseAllTrades();
}

void OpenBuy()
{
   if(isPaused) return;
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double sl = ask - StopLoss_Points * _Point;
   double tp = ask + TakeProfit_Points * _Point;
   double lot = CalculateLotSize();
   
   if(trade.Buy(lot, _Symbol, ask, sl, tp, "App Brain Buy"))
      Print("✅ Buy Order Placed");
   else
      Print("❌ Buy Order Failed: ", GetLastError());
}

void OpenSell()
{
   if(isPaused) return;
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double sl = bid + StopLoss_Points * _Point;
   double tp = bid - TakeProfit_Points * _Point;
   double lot = CalculateLotSize();
   
   if(trade.Sell(lot, _Symbol, bid, sl, tp, "App Brain Sell"))
      Print("✅ Sell Order Placed");
   else
      Print("❌ Sell Order Failed: ", GetLastError());
}

void CloseAllTrades()
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
      {
         trade.PositionClose(posInfo.Ticket());
      }
   }
   Print("✅ All Trades Closed");
}

double CalculateLotSize()
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double lot = MathMax(0.01, MathFloor(equity / 1000.0) * 0.05); // 0.05 lot per $1000
   return MathMin(lot, 10.0);
}
