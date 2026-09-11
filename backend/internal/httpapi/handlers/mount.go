package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Middleware is a standard net/http middleware constructor.
type Middleware = func(http.Handler) http.Handler

// Mount registers every REST route under /api with the correct auth grouping,
// mirroring the .NET controllers (ANALYSIS §3). `protected` is the JWT
// middleware ([Authorize]); `accounts` is the per-account filter ([AccountsAuthorize]).
func (a *API) Mount(api chi.Router, protected, accounts, manager Middleware) {
	// The credential guard (LoginGuard, HGH-02) covers exactly the anonymous
	// routes that accept a credential; nil means no throttling (tests).
	guard := a.d.LoginGuard
	if guard == nil {
		guard = func(next http.Handler) http.Handler { return next }
	}
	// Anonymous controllers.
	api.Route("/Authentication", func(g chi.Router) {
		g.With(guard).Post("/login", a.Login)
		g.With(guard).Post("/crmlogin", a.CRMLogin)
		// Anonymous like the other two: it is authenticated by the CRM token in
		// the body, which is the same credential /login accepts.
		g.With(guard).Post("/accounts", a.Accounts)
		// Session restoration (AUTH-001). Anonymous route, cookie-authenticated:
		// the HttpOnly session cookie set by /login IS the credential here.
		g.Get("/session", a.Session)
		g.Post("/logout", a.Logout)
	})
	// What this gateway can actually do, so the terminal gates features on an
	// answer instead of on a 404.
	api.Get("/Capabilities", a.Capabilities)
	// Protected controllers ([Authorize]).
	api.Group(func(p chi.Router) {
		p.Use(protected)

		p.Route("/Order", func(g chi.Router) {
			g.With(manager).Get("/get", a.OrderGet)
			g.With(accounts).Get("/get_total", a.OrderGetTotal)
			g.With(accounts).Get("/get_page", a.OrderGetPage)
			g.With(accounts).Get("/get_batch", a.OrderGetBatch)
			g.With(manager).Delete("/delete", a.OrderDelete)
			g.With(manager).Post("/update_order", a.OrderUpdate)
			g.With(manager).Get("/cancel", a.OrderCancel)
			g.With(manager).Get("/list", a.OrderList)
			g.With(manager).Get("/getbackup", a.OrderGetBackup)
			g.With(manager).Post("/restore", a.OrderRestore)
			g.With(manager).Get("/reopen", a.OrderReopen)
		})

		p.Route("/Position", func(g chi.Router) {
			g.With(accounts).Get("/get", a.PositionGet)
			g.With(accounts).Get("/get_total", a.PositionGetTotal)
			g.With(accounts).Get("/get_page", a.PositionGetPage)
			g.With(accounts).Get("/get_batch", a.PositionGetBatch)
			g.With(manager).Post("/update_position", a.PositionUpdate)
			g.With(manager).Delete("/delete", a.PositionDelete)
			g.With(manager).Get("/backup_list", a.PositionBackupList)
			g.With(manager).Get("/backup_get", a.PositionBackupGet)
			g.With(manager).Post("/restore", a.PositionRestore)
			g.With(manager).Get("/checkPosition", a.PositionCheck)
			g.With(manager).Get("/fixPosition", a.PositionFix)
		})

		p.Route("/Deal", func(g chi.Router) {
			g.With(manager).Get("/get", a.DealGet)
			g.With(accounts).Get("/get_total", a.DealGetTotal)
			g.With(accounts).Get("/get_page", a.DealGetPage)
			g.With(accounts).Get("/get_batch", a.DealGetBatch)
			g.With(manager).Post("/update_deal", a.DealUpdate)
			g.With(manager).Delete("/delete", a.DealDelete)
			g.With(manager).Get("/backup_list", a.DealBackupList)
			g.With(manager).Get("/backup_get", a.DealBackupGet)
			g.With(manager).Post("/restore_deal", a.DealRestore)
			// Per-fill feed for TradingView's execution markers.
			g.With(accounts).Get("/since", a.ExecutionsSince)
		})

		p.Route("/Alert", func(g chi.Router) {
			g.With(accounts).Get("/list", a.AlertList)
			g.With(accounts).Post("/create", a.AlertCreate)
			g.With(accounts).Delete("/delete", a.AlertDelete)
		})

		p.Route("/Workspace", func(g chi.Router) {
			g.With(accounts).Get("/get", a.WorkspaceGet)
			g.With(accounts).Post("/save", a.WorkspaceSave)
		})

		p.Get("/News/list", a.NewsList)
		p.Get("/Calendar/list", a.CalendarList)

		p.Route("/History", func(g chi.Router) {
			g.With(manager).Get("/get", a.HistoryGet)
			g.With(accounts).Get("/get_total", a.HistoryGetTotal)
			g.With(accounts).Get("/get_page", a.HistoryGetPage)
			g.With(accounts).Get("/get_batch", a.HistoryGetBatch)
			g.With(manager).Delete("/delete", a.HistoryDelete)
			g.With(manager).Post("/update_history", a.HistoryUpdate)
		})

		p.Route("/Symbol", func(g chi.Router) {
			g.Get("/getlist", a.SymbolGetList)
			g.Get("/getsymbolsbyname", a.SymbolGetByName)
			g.Get("/getsymbolsbymask", a.SymbolGetByMask)
			g.Get("/getsymbolsbygroup", a.SymbolGetByGroup)
			g.Get("/getGroup", a.SymbolGetGroup)
		})

		p.Route("/Tick", func(g chi.Router) {
			g.Get("/last", a.TickLast)
			g.Get("/last_group", a.TickLastGroup)
			g.Get("/stat", a.TickStat)
			g.Get("/history", a.TickHistory)
			g.Get("/get", a.TickGet)
			g.Get("/getHistoryby1Dresolution", a.TickHistory1D)
			g.Get("/get_marketdepth", a.TickMarketDepth)
		})

		p.Route("/Trade", func(g chi.Router) {
			g.With(manager).Get("/balance", a.TradeBalance)
			g.Get("/calc_buy_rate", a.TradeCalcBuy)
			g.Get("/calc_sell_rate", a.TradeCalcSell)
			g.With(accounts).Get("/check_margin", a.TradeCheckMargin)
			g.Get("/calc_profit", a.TradeCalcProfit)
			g.With(accounts).Post("/send_request", a.TradeSendRequest)
			g.With(manager).Get("/get_request_result", a.TradeGetRequestResult)
		})

		p.Route("/User", func(g chi.Router) {
			g.With(accounts).Get("/get", a.UserGet)
			g.With(accounts).Get("/get_trade_state", a.UserTradeState)
		})

		p.Route("/Account", func(g chi.Router) {
			g.With(accounts).Get("/leverage", a.LeverageGet)
			g.With(accounts).Post("/leverage", a.LeverageSet)
		})

		p.Route("/Test", func(g chi.Router) {
			g.Get("/getServerTime", a.TestServerTime)
			g.Get("/getUTCTime", a.TestUTCTime)
		})
	})
}
