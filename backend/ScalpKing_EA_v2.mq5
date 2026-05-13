//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v2.mq5 |
//|                                        Your Trading Bot Platform |
//|                     Scalper: Gold (XAU/USD) + Indices (US30/NAS) |
//|                    Strategy: Long & Short SMC Strategy           |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "2.12"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include "FxScalpKing_HTTP.mqh"

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input string   ApiKey            = "FXSK-90e36448c3d1ef9d749aa155ba228541";
input string   ServerURL         = "https://liquibot-back.onrender.com";
input int      MagicNumber       = 20260101;
input int      HeartbeatInterval = 1; // seconds

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade            trade;
CPositionInfo     posInfo;
bool              licenseValid      = false;
datetime          lastHeartbeat     = 0;
string            EA_Name           = "FxScalpKing EA v2.12";

// Indicators
int handle_ema20, handle_atr;

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
   
   handle_ema20 = iMA(_Symbol, PERIOD_CURRENT, 20, 0, MODE_EMA, PRICE_CLOSE);
   handle_atr = iATR(_Symbol, PERIOD_CURRENT, 14);

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
   if(!licenseValid) return;
}

//+------------------------------------------------------------------+
//| HEARTBEAT LOGIC                                                 |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   double ema[1], atr[1];
   CopyBuffer(handle_ema20, 0, 0, 1, ema);
   CopyBuffer(handle_atr, 0, 0, 1, atr);

   string json = "{";
   json += "\"apiKey\":\"" + ApiKey + "\",";
   json += "\"symbol\":\"" + _Symbol + "\",";
   json += "\"price\":" + DoubleToString(tick.bid, _Digits) + ",";
   json += "\"spread\":" + DoubleToString((tick.ask - tick.bid)/_Point, 0) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"ema20\":" + DoubleToString(ema[0], _Digits) + ",";
   json += "\"atr14\":" + DoubleToString(atr[0], _Digits) + ",";
   
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
         json += "\"sl\":" + DoubleToString(posInfo.StopLoss(), _Digits) + ",";
         json += "\"tp\":" + DoubleToString(posInfo.TakeProfit(), _Digits) + "}";
         first = false;
      }
   }
   json += "],";
   
   // Send 48 hours of M5 candles (approximately 576 candles)
   json += "\"candles\":[";
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int lookback = 576; // 48 hours * 12 candles per hour (M5)
   if(CopyRates(_Symbol, _Period, 0, lookback, rates) > 0)
   {
      int actual_copied = ArraySize(rates);
      for(int i=0; i<actual_copied; i++)
      {
         json += "{\"open\":" + DoubleToString(rates[i].open, _Digits) + ",";
         json += "\"high\":" + DoubleToString(rates[i].high, _Digits) + ",";
         json += "\"low\":" + DoubleToString(rates[i].low, _Digits) + ",";
         json += "\"close\":" + DoubleToString(rates[i].close, _Digits) + ",";
         json += "\"timestamp\":" + IntegerToString(rates[i].time) + "}";
         if(i < actual_copied - 1) json += ",";
      }
   }
   json += "]}";

   string resp;
   if(FxScalpKing.SendHeartbeat(json, resp))
   {
      // Optional: Parse immediate response if needed
   }
}

void PollCommands()
{
   string resp = FxScalpKing.GetCommands();
   if(resp == "" || resp == "[]") return;
   
   Print("📡 Commands: ", resp);
   // Simple logic: if BUY or SELL is in string, execute at default lots
   if(StringFind(resp, "\"action\":\"BUY\"") >= 0) trade.Buy(0.01, _Symbol, SymbolInfoDouble(_Symbol, SYMBOL_ASK), 0, 0);
   if(StringFind(resp, "\"action\":\"SELL\"") >= 0) trade.Sell(0.01, _Symbol, SymbolInfoDouble(_Symbol, SYMBOL_BID), 0, 0);
}
