//+------------------------------------------------------------------+
//|                                                   FxScalpKing EA  |
//|                                    Copyright 2024, FxScalpKing     |
//|                                             https://fxscalpking.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2024, FxScalpKing"
#property link      "https://fxscalpking.com"
#property version   "1.00"

#include <Trade\Trade.mqh>

input string ServerURL = "https://liquibot-back.onrender.com";
input string ApiKey = "FXSK-YOUR-API-KEY";
input int UpdateInterval = 5; // seconds

CTrade trade;

datetime lastUpdateTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    // Validate API key with backend
    string response = SendToBackend("/api/ea/validate", 
        "{\"apiKey\":\"" + ApiKey + "\"}", "POST");
    
    if(StringFind(response, "\"valid\":true") < 0)
    {
        Print("EA Validation Failed: ", response);
        return(INIT_FAILED);
    }
    
    Print("EA Connected to Backend Successfully");
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
    Print("EA Disconnected from Backend");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    // Update backend every N seconds
    if(TimeCurrent() - lastUpdateTime >= UpdateInterval)
    {
        SendAccountData();
        lastUpdateTime = TimeCurrent();
    }
}

//+------------------------------------------------------------------+
//| Send account data to backend                                     |
//+------------------------------------------------------------------+
void SendAccountData()
{
    // Get account information
    double balance = AccountInfoDouble(ACCOUNT_BALANCE);
    double equity = AccountInfoDouble(ACCOUNT_EQUITY);
    double profit = AccountInfoDouble(ACCOUNT_PROFIT);
    string symbol = Symbol();
    double price = SymbolInfoDouble(symbol, SYMBOL_BID);
    
    // Get open positions
    string positionsJson = GetPositionsJson();
    
    // Get technical indicators
    string indicatorsJson = GetIndicatorsJson();
    
    // Get market structures
    string structuresJson = GetStructuresJson();
    
    // Build JSON data
    string jsonData = "{";
    jsonData += "\"accountData\":{";
    jsonData += "\"balance\":" + DoubleToString(balance, 2) + ",";
    jsonData += "\"equity\":" + DoubleToString(equity, 2) + ",";
    jsonData += "\"profit\":" + DoubleToString(profit, 2) + ",";
    jsonData += "\"price\":" + DoubleToString(price, 2) + ",";
    jsonData += "\"symbol\":\"" + symbol + "\",";
    jsonData += "\"positions\":" + positionsJson + ",";
    jsonData += indicatorsJson;
    jsonData += "},";
    jsonData += "\"testStructures\":" + structuresJson;
    jsonData += "}";
    
    // Send to backend
    string response = SendToBackend("/api/ea/update", jsonData, "POST");
    
    if(StringFind(response, "\"ea_connected\":true") >= 0)
    {
        Print("Data sent successfully");
    }
    else
    {
        Print("Failed to send data: ", response);
    }
}

//+------------------------------------------------------------------+
//| Get open positions as JSON                                       |
//+------------------------------------------------------------------+
string GetPositionsJson()
{
    string json = "[";
    
    for(int i = 0; i < PositionsTotal(); i++)
    {
        if(PositionSelectByIndex(i))
        {
            if(i > 0) json += ",";
            
            json += "{";
            json += "\"ticket\":\"" + IntegerToString(PositionGetInteger(POSITION_TICKET)) + "\",";
            json += "\"symbol\":\"" + PositionGetString(POSITION_SYMBOL) + "\",";
            json += "\"type\":\"" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\",";
            json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ",";
            json += "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + ",";
            json += "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",";
            json += "\"time\":" + IntegerToString(PositionGetInteger(POSITION_TIME)) + "";
            json += "}";
        }
    }
    
    json += "]";
    return json;
}

//+------------------------------------------------------------------+
//| Get technical indicators as JSON                                 |
//+------------------------------------------------------------------+
string GetIndicatorsJson()
{
    string symbol = Symbol();
    
    // Get EMAs
    double emaFast[], emaSlow[];
    ArraySetAsSeries(emaFast, true);
    ArraySetAsSeries(emaSlow, true);
    
    int fastHandle = iMA(symbol, PERIOD_CURRENT, 12, 0, MODE_EMA, PRICE_CLOSE);
    int slowHandle = iMA(symbol, PERIOD_CURRENT, 26, 0, MODE_EMA, PRICE_CLOSE);
    
    CopyBuffer(fastHandle, 0, 0, 1, emaFast);
    CopyBuffer(slowHandle, 0, 0, 1, emaSlow);
    
    // Get Bollinger Bands
    double bbUpper[], bbLower[];
    ArraySetAsSeries(bbUpper, true);
    ArraySetAsSeries(bbLower, true);
    
    int bbHandle = iBands(symbol, PERIOD_CURRENT, 20, 0, 2.0, PRICE_CLOSE);
    CopyBuffer(bbHandle, 1, 0, 1, bbUpper);
    CopyBuffer(bbHandle, 2, 0, 1, bbLower);
    
    // Get RSI
    double rsi[];
    ArraySetAsSeries(rsi, true);
    
    int rsiHandle = iRSI(symbol, PERIOD_CURRENT, 14, PRICE_CLOSE);
    CopyBuffer(rsiHandle, 0, 0, 1, rsi);
    
    // Get ATR
    double atr[];
    ArraySetAsSeries(atr, true);
    
    int atrHandle = iATR(symbol, PERIOD_CURRENT, 14);
    CopyBuffer(atrHandle, 0, 0, 1, atr);
    
    string json = "";
    json += "\"fastEMA\":" + DoubleToString(emaFast[0], 5) + ",";
    json += "\"slowEMA\":" + DoubleToString(emaSlow[0], 5) + ",";
    json += "\"bbUpper\":" + DoubleToString(bbUpper[0], 5) + ",";
    json += "\"bbLower\":" + DoubleToString(bbLower[0], 5) + ",";
    json += "\"rsi\":" + DoubleToString(rsi[0], 2) + ",";
    json += "\"atr\":" + DoubleToString(atr[0], 5) + "";
    
    return json;
}

//+------------------------------------------------------------------+
//| Get market structures as JSON                                   |
//+------------------------------------------------------------------+
string GetStructuresJson()
{
    // This is a placeholder - implement your structure detection logic here
    string json = "{";
    json += "\"M5\":{";
    json += "\"orderBlocks\":[],";
    json += "\"fvgs\":[],";
    json += "\"keyLevels\":[]";
    json += "},";
    json += "\"M15\":{";
    json += "\"orderBlocks\":[],";
    json += "\"fvgs\":[],";
    json += "\"keyLevels\":[]";
    json += "}";
    json += "}";
    
    return json;
}

//+------------------------------------------------------------------+
//| Send data to backend using WebRequest                            |
//+------------------------------------------------------------------+
string SendToBackend(string endpoint, string data, string method)
{
    string url = ServerURL + endpoint;
    string result = "";
    string headers = "Content-Type: application/json\r\n";
    
    int timeout = 10000; // 10 seconds
    
    int res = WebRequest(url, headers, timeout, data, result, headers);
    
    if(res == 200)
    {
        return result;
    }
    else
    {
        Print("WebRequest failed with error: ", res);
        return "";
    }
}
