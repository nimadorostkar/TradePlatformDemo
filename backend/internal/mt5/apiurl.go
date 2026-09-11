package mt5

// Canonical MT5 Manager Web API path templates, copied verbatim from the .NET
// LegacyMTSocket.Core/Helpers/APIUrl.cs (see docs/ANALYSIS.md §7.5). These are
// fmt-style format strings; argument order matches the original {0},{1},...
//
// PARITY: every template — including the deliberate quirk on DeleteClosedOrder
// ("ticket=tickets", a literal with no placeholder) — must be reproduced
// exactly so the upstream requests are byte-identical to the .NET service.
const (
	// Auth / Test
	PathAuthStart  = "/api/auth/start?version=%s&agent=%s&login=%d&type=%s"
	PathAuthAnswer = "/api/auth/answer?srv_rand_answer=%s&cli_rand=%s"
	PathPing       = "/api/test/access"

	// Order
	PathOrderGet        = "/api/order/get?ticket=%d"
	PathOrderGetTotal   = "/api/order/get_total?login=%d"
	PathOrderGetPage    = "/api/order/get_page?login=%d&offset=%d&total=%d"
	PathOrderGetBatch   = "/api/order/get_batch?login=%d&group=%s&ticket=%s&symbol=%s"
	PathOrderDelete     = "/api/order/delete?ticket=%s"
	PathOrderCancel     = "/api/order/cancel?ticket=%s"
	PathOrderUpdate     = "/api/order/update"
	PathOrderBackupList = "/api/order/backup/list?from=%d&to=%d&server=%s"
	PathOrderBackupGet  = "/api/order/backup/get?backup=%s&login=%d&ticket=%d&from=%d&to=%d&server=%s"
	PathOrderBackupRest = "/api/order/backup/restore"
	PathOrderReopen     = "/api/order/reopen?ticket=%d"

	// History (closed orders)
	PathHistoryGet      = "/api/history/get?ticket=%d"
	PathHistoryGetTotal = "/api/history/get_total?login=%d&from=%s&to=%s"
	PathHistoryGetPage  = "/api/history/get_page?login=%d&from=%d&to=%d&offset=%d&total=%d"
	PathHistoryGetBatch = "/api/history/get_batch?login=%d&group=%s&ticket=%s&from=%s&to=%s&symbol=%s"
	PathHistoryUpdate   = "/api/history/update"
	// QUIRK preserved verbatim: literal "tickets", no placeholder (ANALYSIS §3.5/§7.5).
	PathHistoryDelete = "/api/history/delete?ticket=tickets"

	// Deal
	PathDealGet        = "/api/deal/get?ticket=%d"
	PathDealGetTotal   = "/api/deal/get_total?login=%d&from=%s&to=%s"
	PathDealGetPage    = "/api/deal/get_page?login=%d&from=%s&to=%s&offset=%d&total=%d"
	PathDealGetBatch   = "/api/deal/get_batch?login=%d&group=%s&ticket=%d&from=%s&to=%s&symbol=%s"
	PathDealUpdate     = "/api/deal/update"
	PathDealDelete     = "/api/deal/delete?ticket=%d"
	PathDealBackupList = "/api/deal/backup/list?from=%d&to=%d&server=%s"
	PathDealBackupGet  = "/api/deal/backup/get?backup=%s&login=%d&from=%d&to=%d&server=%s"
	PathDealBackupRest = "/api/deal/backup/restore"

	// Position
	PathPositionGet        = "/api/position/get?login=%d&symbol=%s"
	PathPositionGetTotal   = "/api/position/get_total?login=%d"
	PathPositionGetPage    = "/api/position/get_page?login=%d&offset=%d&total=%d"
	PathPositionGetBatch   = "/api/position/get_batch?login=%d&group=%s&ticket=%d&symbol=%s"
	PathPositionUpdate     = "/api/position/update"
	PathPositionDelete     = "/api/position/delete?ticket=%d"
	PathPositionBackupList = "/api/position/backup/list?from=%d&to=%d&server=%s"
	PathPositionBackupGet  = "/api/position/backup/get?backup=%s&login=%d&from=%d&to=%d&server=%s"
	PathPositionBackupRest = "/api/position/backup/restore"
	PathPositionCheck      = "/api/position/check?login=%d"
	PathPositionFix        = "/api/position/fix?login=%d"

	// Trade / Dealer — query values forwarded as raw strings to avoid numeric
	// formatting divergence from the values clients send.
	PathTradeBalance       = "/api/trade/balance?login=%s&type=%s&balance=%s&comment=%s"
	PathTradeCalcRateBuy   = "/api/trade/calc_rate_buy?base=%s&currency=%s&group=%s&symbol=%s&price=%s"
	PathTradeCalcRateSell  = "/api/trade/calc_rate_sell?base=%s&currency=%s&group=%s&symbol=%s&price=%s"
	PathTradeCheckMargin   = "/api/trade/check_margin?login=%s&symbol=%s&type=%s&volume=%s&price=%s"
	PathTradeCalcProfit    = "/api/trade/calc_profit?group=%s&symbol=%s&type=%s&volume=%s&price_open=%s&price_close=%s"
	PathDealerSendRequest  = "/api/dealer/send_request"
	PathDealerRequestReslt = "/api/dealer/get_request_result?id=%d"

	// Tick / Chart / Book
	PathTickLast      = "/api/tick/last?symbol=%s&trans_id=%d"
	PathTickLastGroup = "/api/tick/last_group?symbol=%s&group=%s&trans_id=%d"
	PathTickStat      = "/api/tick/stat?symbol=%s&trans_id=%d"
	PathTickHistory   = "/api/tick/history?symbol=%s&from=%d&to=%d&data=%s"
	PathChartGet      = "/api/chart/get?symbol=%s&from=%d&to=%d&data=%s"
	PathBookGet       = "/api/book/get?symbol=%s"
	// MT5 delivers depth to SUBSCRIBERS: book/get returns whatever the server
	// last pushed to this connection, which is nothing at all until the symbol
	// has been subscribed. Every MT5 depth surface works this way (MQL5
	// MarketBookAdd, Python market_book_add, Manager MTBookAPI::Subscribe).
	PathBookSubscribe = "/api/book/subscribe?symbol=%s"

	// User
	PathUserGet        = "/api/user/get?login=%d"
	PathUserAccountGet = "/api/user/account/get?login=%d"
	// PathUserUpdate takes the WHOLE user record. MT5 replaces the record with
	// what it is sent, so a caller must read, change one field, and send the
	// rest back untouched — a partial body silently clears everything absent
	// from it.
	PathUserUpdate = "/api/user/update"

	// Symbol / Group
	PathSymbolList    = "/api/symbol/list"
	PathSymbolGet     = "/api/symbol/get?symbol=%s"
	PathSymbolMask    = "/api/symbol/get?mask=%s"
	PathSymbolByGroup = "/api/symbol/get_group?symbol=%s&group=%s"
	PathGroupGet      = "/api/group/get?group=%s"

	// CRM (external auth provider; appended to MT5Config.CRMUrl, not the MT5 host)
	PathCRMLogin    = "/client-api/login?version=1.0.0"
	PathCRMAccounts = "/client-api/accounts?version=1.0.0"
)
