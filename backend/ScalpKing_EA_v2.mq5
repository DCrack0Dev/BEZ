//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v2.mq5 |
//|                                        Your Trading Bot Platform |
//|                     Scalper: Gold (XAU/USD) + Indices (US30/NAS) |
//|                    Strategy: Long & Short SMC Strategy           |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "2.10"
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
input int      HeartbeatInterval = 1; // 1 second for aggressive updates
input int      CommandInterval   = 500; // 500ms polling

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade            trade;
CPositionInfo     posInfo;

int            handle_EMA20_M5;
int            handle_ATR14_M5;

bool           licenseValid      = false;
datetime       lastCommandPoll   = 0;
string         EA_Name           = "FxScalpKing EA v2.1";

//+------------------------------------------------------------------+
//| EXPERT INITIALIZATION                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("=== ", EA_Name, " Starting ===");
   
   FxScalpKing.SetServerUrl(ServerURL);
   FxScalpKing.SetApiKey(ApiKey);

   if(!ValidateLicense())
   {
      Alert("❌ Invalid or expired API Key.");
      return INIT_FAILED;
   }
   licenseValid = true;

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(10);

   handle_EMA20_M5 = iMA(_Symbol, PERIOD_M5, 20, 0, MODE_EMA, PRICE_CLOSE);
   handle_ATR14_M5 = iATR(_Symbol, PERIOD_M5, 14);

   EventSetTimer(1); // Timer for heartbeats and polling
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EXPERT DEINITIALIZATION                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   IndicatorRelease(handle_EMA20_M5);
   IndicatorRelease(handle_ATR14_M5);
}

//+------------------------------------------------------------------+
//| EXPERT TIMER                                                     |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(!licenseValid) return;
   
   SendHeartbeat();
   
   // Poll for commands every 500ms
   if(GetTickCount() - lastCommandPoll >= CommandInterval)
   {
      PollCommands();
      lastCommandPoll = GetTickCount();
   }
}

//+------------------------------------------------------------------+
//| MAIN TICK FUNCTION                                               |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!licenseValid) return;
   SendHeartbeat();
}

//+------------------------------------------------------------------+
//| SEND HEARTBEAT DATA                                              |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   MqlTick last_tick;
   if(!SymbolInfoTick(_Symbol, last_tick)) return;

   double ema20[2], atr14[1];
   CopyBuffer(handle_EMA20_M5, 0, 0, 2, ema20);
   CopyBuffer(handle_ATR14_M5, 0, 0, 1, atr14);

   string json = "{";
   json += "\"symbol\":\"" + _Symbol + "\",";
   json += "\"bid\":" + DoubleToString(last_tick.bid, _Digits) + ",";
   json += "\"ask\":" + DoubleToString(last_tick.ask, _Digits) + ",";
   json += "\"spread\":" + DoubleToString((last_tick.ask - last_tick.bid) / _Point, 0) + ",";
   json += "\"ema20\":" + DoubleToString(ema20[0], _Digits) + ",";
   json += "\"ema20Prev\":" + DoubleToString(ema20[1], _Digits) + ",";
   json += "\"atr14\":" + DoubleToString(atr14[0], _Digits) + ",";
   json += "\"pipValue\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE), 2) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"pipSize\":" + DoubleToString(_Point * 10, 5) + ","; // Default 10 points per pip
   json += "\"pointSize\":" + DoubleToString(_Point, 5) + ",";
   json += "\"minLot\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), 2) + ",";
   json += "\"maxLot\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), 2) + ",";
   json += "\"minLotStep\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP), 2) + ",";
   
   // Add candles
   json += "\"candles\":[";
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, _Period, 0, 20, rates) > 0)
   {
      for(int i = 0; i < 20; i++)
      {
         json += "{\"open\":" + DoubleToString(rates[i].open, _Digits) + ",";
         json += "\"high\":" + DoubleToString(rates[i].high, _Digits) + ",";
         json += "\"low\":" + DoubleToString(rates[i].low, _Digits) + ",";
         json += "\"close\":" + DoubleToString(rates[i].close, _Digits) + ",";
         json += "\"volume\":" + IntegerToString(rates[i].tick_volume) + ",";
         json += "\"timestamp\":" + IntegerToString(rates[i].time) + "}";
         if(i < 19) json += ",";
      }
   }
   json += "],";
   
   // Add open positions
   json += "\"openPositions\":[";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol)
      {
         json += "{\"ticket\":\"" + IntegerToString(posInfo.Ticket()) + "\",";
         json += "\"type\":\"" + (posInfo.PositionType() == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\",";
         json += "\"lots\":" + DoubleToString(posInfo.Volume(), 2) + ",";
         json += "\"price\":" + DoubleToString(posInfo.PriceOpen(), _Digits) + ",";
         json += "\"sl\":" + DoubleToString(posInfo.StopLoss(), _Digits) + ",";
         json += "\"tp\":" + DoubleToString(posInfo.TakeProfit(), _Digits) + ",";
         json += "\"profit\":" + DoubleToString(posInfo.Profit(), 2) + "}";
         if(i > 0) json += ",";
      }
   }
   json += "]";
   json += "}";

   FxScalpKing.Post("/api/ea/update", json);
}

//+------------------------------------------------------------------+
//| POLL FOR COMMANDS                                                |
//+------------------------------------------------------------------+
void PollCommands()
{
   string response = FxScalpKing.Get("/api/ea/commands");
   if(response == "" || response == "[]") return;

   // Simple JSON parser for commands
   // Expected: [{"action":"BUY","lots":0.1,"sl":1.234,"tp":1.235,"ticket":"123"}]
   // In a real scenario, use a proper JSON library for MQL5.
   
   // For demonstration, we'll look for keywords
   if(StringFind(response, "\"action\":\"BUY\"") >= 0) OpenBuy();
   if(StringFind(response, "\"action\":\"SELL\"") >= 0) OpenSell();
   if(StringFind(response, "\"action\":\"MODIFY_SL\"") >= 0)
   {
      // Parse ticket and new SL from response
      // trade.PositionModify(ticket, sl, tp);
   }
}

//+------------------------------------------------------------------+
//| EXECUTION WRAPPERS                                               |
//+------------------------------------------------------------------+
void OpenBuy(double lots = 0.01, double sl = 0, double tp = 0)
{
   if(trade.Buy(lots, _Symbol, SymbolInfoDouble(_Symbol, SYMBOL_ASK), sl, tp))
      Print("✅ Buy Order Sent: ", lots, " lots");
   else
      Print("❌ Buy Order Failed: ", GetRetcodeDescription(trade.ResultRetcode()));
}

void OpenSell(double lots = 0.01, double sl = 0, double tp = 0)
{
   if(trade.Sell(lots, _Symbol, SymbolInfoDouble(_Symbol, SYMBOL_BID), sl, tp))
      Print("✅ Sell Order Sent: ", lots, " lots");
   else
      Print("❌ Sell Order Failed: ", GetRetcodeDescription(trade.ResultRetcode()));
}

bool ValidateLicense() { return true; } // Mock for now
string GetRetcodeDescription(int code) { return IntegerToString(code); }
