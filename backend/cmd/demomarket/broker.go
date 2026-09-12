package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Demo broker: a real execution engine on the MT5 Manager API contract ────
//
// Every account is a hedging account in USD: market orders fill at the live
// bid/ask, pending orders rest until the market reaches them, stops and
// targets close positions when touched, margin is checked before every open
// and a stop-out closes losers at 50 % margin level. Everything the terminal
// reads — positions, working orders, order history, deals, the account
// summary — is derived from this state, and every mutation is a dealer
// request exactly as the gateway sends it to a real trading server.
//
// Nothing is real: the counterparty is this process, and the balance is the
// demo funding of the user store. The state survives a restart when
// BROKER_STATE_FILE is set (dev.sh and the compose stack both set it).

// Volumes are MT5 units: 1 lot = 10000.
const (
	volumeUnitsPerLot = 10000.0
	volumeMin         = 1000    // 0.1 lot
	volumeMax         = 5000000 // 500 lots
	volumeStep        = 1000
	defaultLeverage   = 100
	stopOutLevel      = 50.0 // margin level (%) at which losers are closed
)

// MT5 order types (IMTOrder::EnOrderType).
const (
	typeBuy           = 0
	typeSell          = 1
	typeBuyLimit      = 2
	typeSellLimit     = 3
	typeBuyStop       = 4
	typeSellStop      = 5
	typeBuyStopLimit  = 6
	typeSellStopLimit = 7
)

// MT5 order states (IMTOrder::EnOrderState).
const (
	statePlaced   = 1
	stateCanceled = 2
	stateFilled   = 4
	stateRejected = 5
	stateExpired  = 6
)

// MT5 order lifetimes (IMTOrder::EnOrderTime).
const (
	timeGTC       = 0
	timeDay       = 1
	timeSpecified = 2
	timeSpecDay   = 3
)

// Dealer request actions as the gateway forwards them (TradeRequest.Action).
const (
	actionExecute      = "200" // market: open, or close when Position is set
	actionPending      = "201"
	actionModifyPos    = "202" // SL/TP on a position
	actionModifyOrder  = "203"
	actionRemoveOrder  = "204"
	actionExecuteMQL   = "1" // TRADE_ACTION_DEAL, accepted for API clients
	actionPendingMQL   = "5"
	actionModifyPosMQL = "6"
	actionModOrderMQL  = "7"
	actionRemoveMQL    = "8"
)

// Retcodes (MT5 trade server return codes) with the text MT5 attaches.
const (
	rcPlaced       = "10008 Placed"
	rcDone         = "10009 Done"
	rcRejected     = "10006 Rejected"
	rcInvalid      = "10013 Invalid request"
	rcInvalidVol   = "10014 Invalid volume"
	rcInvalidPrice = "10015 Invalid price"
	rcInvalidStops = "10016 Invalid stops"
	rcMarketClosed = "10018 Market closed"
	rcNoMoney      = "10019 No money"
	rcNoQuotes     = "10021 No quotes"
	rcNoChanges    = "10025 No changes"
	rcInvalidType  = "10035 Invalid order type"
	rcPosClosed    = "10036 Position closed"
)

type position struct {
	Ticket     int64   `json:"ticket"`
	Login      int64   `json:"login"`
	Symbol     string  `json:"symbol"`
	Action     int     `json:"action"` // 0 buy, 1 sell
	TimeCreate int64   `json:"timeCreate"`
	PriceOpen  float64 `json:"priceOpen"`
	PriceSL    float64 `json:"priceSL"`
	PriceTP    float64 `json:"priceTP"`
	Volume     int64   `json:"volume"` // MT5 units
	Storage    float64 `json:"storage"`
	Commission float64 `json:"commission"`
	Comment    string  `json:"comment"`
}

type order struct {
	Ticket         int64   `json:"ticket"`
	Login          int64   `json:"login"`
	Symbol         string  `json:"symbol"`
	Type           int     `json:"type"`
	State          int     `json:"state"`
	TimeSetup      int64   `json:"timeSetup"`
	TimeDone       int64   `json:"timeDone"`
	PriceOrder     float64 `json:"priceOrder"`
	PriceTrigger   float64 `json:"priceTrigger"`
	PriceSL        float64 `json:"priceSL"`
	PriceTP        float64 `json:"priceTP"`
	VolumeInitial  int64   `json:"volumeInitial"`
	VolumeCurrent  int64   `json:"volumeCurrent"`
	TypeTime       int     `json:"typeTime"`
	TimeExpiration int64   `json:"timeExpiration"`
	PositionID     int64   `json:"positionId"`
	Comment        string  `json:"comment"`
}

type deal struct {
	Ticket     int64   `json:"ticket"`
	Order      int64   `json:"order"`
	Login      int64   `json:"login"`
	Symbol     string  `json:"symbol"`
	Action     int     `json:"action"` // 0 buy, 1 sell, 2 balance
	Entry      int     `json:"entry"`  // 0 in, 1 out
	Price      float64 `json:"price"`
	Volume     int64   `json:"volume"`
	TimeMsc    int64   `json:"timeMsc"`
	Commission float64 `json:"commission"`
	Storage    float64 `json:"storage"`
	Profit     float64 `json:"profit"`
	PositionID int64   `json:"positionId"`
	Comment    string  `json:"comment"`
}

type account struct {
	Login     int64               `json:"login"`
	Balance   float64             `json:"balance"`
	Credit    float64             `json:"credit"`
	Leverage  int                 `json:"leverage"`
	Currency  string              `json:"currency"`
	Positions map[int64]*position `json:"positions"`
	Orders    map[int64]*order    `json:"orders"`  // working
	History   []*order            `json:"history"` // final states, oldest first
	Deals     []*deal             `json:"deals"`   // oldest first
}

// brokerState is the persisted book (see store.go for the backends).
type brokerState struct {
	NextTicket  int64              `json:"nextTicket"`
	NextRequest int64              `json:"nextRequest"`
	Accounts    map[int64]*account `json:"accounts"`
}

// sessionClock is the time the engine checks trading sessions against.
// Tests pin it to a weekday so the book is not closed on weekends.
var sessionClock = time.Now

type demoBroker struct {
	provider Provider
	users    UserStore
	store    BrokerStore // nil: the book lives only in memory

	mu          sync.Mutex
	accounts    map[int64]*account
	nextTicket  int64
	nextRequest int64
	results     map[int64]string // dealer request id → PlaceOrderAnswer JSON
	dirty       bool
}

func newDemoBroker(provider Provider, users UserStore, store BrokerStore) *demoBroker {
	b := &demoBroker{
		provider: provider, users: users, store: store,
		accounts: map[int64]*account{}, nextTicket: 600001, nextRequest: 1,
		results: map[int64]string{},
	}
	b.load()
	return b
}

// ── Persistence ─────────────────────────────────────────────────────────────

func (b *demoBroker) load() {
	if b.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st, err := b.store.Load(ctx)
	if err != nil {
		log.Printf("broker: cannot load the book from %s (%v); starting empty", b.store.Name(), err)
		return
	}
	if st == nil {
		return
	}
	b.restore(st)
	log.Printf("broker: restored %d account(s) from %s", len(st.Accounts), b.store.Name())
}

// restore adopts a persisted book. Also used to import a state file into an
// empty database (see importStateFile).
func (b *demoBroker) restore(st *brokerState) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if st.NextTicket > b.nextTicket {
		b.nextTicket = st.NextTicket
	}
	if st.NextRequest > b.nextRequest {
		b.nextRequest = st.NextRequest
	}
	for login, a := range st.Accounts {
		if a.Positions == nil {
			a.Positions = map[int64]*position{}
		}
		if a.Orders == nil {
			a.Orders = map[int64]*order{}
		}
		b.accounts[login] = a
		// The user store's balance follows the engine's: the engine is the
		// one that settled the trades that moved it.
		_ = b.users.SetBalance(context.Background(), login, a.Balance)
	}
}

// save persists the book when something changed. Called from the engine
// loop, never from a request, and the write happens outside the lock so a
// slow disk or database never delays a fill.
func (b *demoBroker) save() {
	if b.store == nil {
		return
	}
	b.mu.Lock()
	if !b.dirty {
		b.mu.Unlock()
		return
	}
	st := b.snapshot()
	b.dirty = false
	b.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := b.store.Save(ctx, st); err != nil {
		log.Printf("broker: save to %s: %v", b.store.Name(), err)
		// Try again on the next tick rather than losing the change.
		b.mu.Lock()
		b.dirty = true
		b.mu.Unlock()
	}
}

// ── Accounts ────────────────────────────────────────────────────────────────

// acct returns the engine's record for a login, creating it from the user
// store on first touch. ok=false for a login the CRM does not know.
// Caller holds b.mu.
func (b *demoBroker) acct(login int64) (*account, bool) {
	if a, ok := b.accounts[login]; ok {
		return a, true
	}
	rec, ok := b.users.AccountByLogin(context.Background(), login)
	if !ok {
		return nil, false
	}
	a := &account{
		Login: login, Balance: rec.Balance, Leverage: defaultLeverage, Currency: rec.Currency,
		Positions: map[int64]*position{}, Orders: map[int64]*order{},
	}
	if a.Currency == "" {
		a.Currency = "USD"
	}
	b.accounts[login] = a
	b.dirty = true
	return a, true
}

func (b *demoBroker) ticket() int64 {
	t := b.nextTicket
	b.nextTicket++
	return t
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func lots(units int64) float64 { return float64(units) / volumeUnitsPerLot }

// ── Pricing ─────────────────────────────────────────────────────────────────

// quote is the current bid/ask of a listed instrument. ok=false before the
// first price arrives or while the instrument's session is closed.
func (b *demoBroker) quote(ins *instrument) (Tick, bool) {
	if ins == nil {
		return Tick{}, false
	}
	t, ok := b.provider.Tick(ins)
	if !ok || t.Bid <= 0 || t.Ask <= 0 {
		return Tick{}, false
	}
	return t, true
}

// mid of a currency pair by symbol; ok=false when unlisted or unpriced.
func (b *demoBroker) mid(symbol string) (float64, bool) {
	t, ok := b.quote(bySymbol[symbol])
	if !ok {
		return 0, false
	}
	return (t.Bid + t.Ask) / 2, true
}

// toUSD converts an amount in ccy to the account currency (USD) through the
// listed USD pairs; an unlisted currency passes through unconverted rather
// than silently zeroing a profit.
func (b *demoBroker) toUSD(ccy string, amount float64) float64 {
	if ccy == "USD" || amount == 0 {
		return amount
	}
	if rate, ok := b.mid("USD" + ccy); ok && rate > 0 {
		return amount / rate
	}
	if rate, ok := b.mid(ccy + "USD"); ok {
		return amount * rate
	}
	return amount
}

// notionalUSD is the USD value of a volume of the instrument at price.
func (b *demoBroker) notionalUSD(ins *instrument, units int64, price float64) float64 {
	baseAmount := lots(units) * ins.contract()
	if ins.Base == "USD" {
		return baseAmount
	}
	if ins.Profit == "USD" {
		return baseAmount * price
	}
	return b.toUSD(ins.Base, baseAmount)
}

func (b *demoBroker) marginFor(a *account, ins *instrument, units int64, price float64) float64 {
	lev := a.Leverage
	if lev <= 0 {
		lev = defaultLeverage
	}
	return round2(b.notionalUSD(ins, units, price) / float64(lev))
}

// floatingProfit values an open position at the current quote, in USD.
func (b *demoBroker) floatingProfit(p *position, t Tick) float64 {
	ins := bySymbol[p.Symbol]
	if ins == nil {
		return 0
	}
	var diff float64
	if p.Action == typeBuy {
		diff = t.Bid - p.PriceOpen
	} else {
		diff = p.PriceOpen - t.Ask
	}
	return round2(b.toUSD(ins.Profit, diff*lots(p.Volume)*ins.contract()))
}

// summary is the account's live equity figures. Caller holds b.mu.
type summary struct {
	Balance, Credit, Profit, Equity, Margin, MarginFree, MarginLevel float64
}

func (b *demoBroker) summarize(a *account) summary {
	s := summary{Balance: a.Balance, Credit: a.Credit}
	for _, p := range a.Positions {
		ins := bySymbol[p.Symbol]
		if t, ok := b.quote(ins); ok {
			s.Profit += b.floatingProfit(p, t) + p.Storage + p.Commission
			s.Margin += b.marginFor(a, ins, p.Volume, p.PriceOpen)
		}
	}
	s.Profit = round2(s.Profit)
	s.Margin = round2(s.Margin)
	s.Equity = round2(a.Balance + a.Credit + s.Profit)
	s.MarginFree = round2(s.Equity - s.Margin)
	if s.Margin > 0 {
		s.MarginLevel = round2(s.Equity / s.Margin * 100)
	}
	return s
}

// ── Dealer requests ─────────────────────────────────────────────────────────

// tradeRequest is the dealer request body as the gateway forwards it. MT5
// clients send numbers both bare and quoted, so every field is lenient.
type tradeRequest struct {
	Action         string
	Login          int64
	Symbol         string
	Type           int
	Volume         int64
	PriceOrder     float64
	PriceTrigger   float64
	PriceSL        float64
	PriceTP        float64
	Position       int64
	Order          int64
	TypeTime       int
	TimeExpiration int64
	Comment        string
}

func parseTradeRequest(body []byte) (tradeRequest, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return tradeRequest{}, err
	}
	get := func(name string) string {
		for k, v := range raw {
			if strings.EqualFold(k, name) {
				return strings.Trim(strings.TrimSpace(string(v)), `"`)
			}
		}
		return ""
	}
	num := func(name string) float64 {
		f, _ := strconv.ParseFloat(get(name), 64)
		return f
	}
	return tradeRequest{
		Action:         get("Action"),
		Login:          int64(num("Login")),
		Symbol:         get("Symbol"),
		Type:           int(num("Type")),
		Volume:         int64(math.Round(num("Volume"))),
		PriceOrder:     num("PriceOrder"),
		PriceTrigger:   num("PriceTrigger"),
		PriceSL:        num("PriceSL"),
		PriceTP:        num("PriceTP"),
		Position:       int64(num("Position")),
		Order:          int64(num("Order")),
		TypeTime:       int(num("TypeTime")),
		TimeExpiration: int64(num("TimeExpiration")),
		Comment:        get("Comment"),
	}, nil
}

// answer is the PlaceOrderAnswer the gateway polls for after a submission.
type answer struct {
	Order          int64
	Symbol         string
	Type           int
	Volume         int64
	PriceOrder     float64
	PriceSL        float64
	PriceTP        float64
	Comment        string
	Retcode        string
	ResultPrice    float64
	ResultVolume   int64
	TypeTime       int
	TimeExpiration int64
}

func (an answer) json(digits int) string {
	return fmt.Sprintf(`{"Order":"%d","ExternalID":"","Symbol":%q,"Type":"%d","Volume":%d,"PriceOrder":%s,"PriceSL":%s,"PriceTP":%s,"Comment":%q,"ResultRetcode":%q,"ResultPrice":%s,"ResultVolume":%d,"TypeTime":%d,"TimeExpiration":%d}`,
		an.Order, an.Symbol, an.Type, an.Volume, ftoa(an.PriceOrder, digits), ftoa(an.PriceSL, digits), ftoa(an.PriceTP, digits),
		an.Comment, an.Retcode, ftoa(an.ResultPrice, digits), an.ResultVolume, an.TypeTime, an.TimeExpiration)
}

// Submit executes a dealer request and returns the request id under which
// its result can be polled. A request the engine cannot even parse gets a
// definitive retcode with no id, exactly as MT5 answers a malformed body.
func (b *demoBroker) Submit(body []byte) (id int64, retcode string) {
	req, err := parseTradeRequest(body)
	if err != nil {
		return 0, rcInvalid
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	an := b.execute(req)
	id = b.nextRequest
	b.nextRequest++
	digits := 5
	if ins := bySymbol[req.Symbol]; ins != nil {
		digits = ins.Digits
	}
	b.results[id] = an.json(digits)
	b.dirty = true
	log.Printf("broker: login %d action %s %s type %d vol %d → %s (order %d @ %s)", req.Login, req.Action, req.Symbol, req.Type, req.Volume, an.Retcode, an.Order, ftoa(an.ResultPrice, digits))
	return id, ""
}

// Result returns the polled result JSON for a request id.
func (b *demoBroker) Result(id int64) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	r, ok := b.results[id]
	return r, ok
}

// execute routes one request. Caller holds b.mu.
func (b *demoBroker) execute(req tradeRequest) answer {
	an := answer{Symbol: req.Symbol, Type: req.Type, Volume: req.Volume, PriceOrder: req.PriceOrder,
		PriceSL: req.PriceSL, PriceTP: req.PriceTP, Comment: req.Comment, TypeTime: req.TypeTime, TimeExpiration: req.TimeExpiration}
	a, ok := b.acct(req.Login)
	if !ok {
		an.Retcode = rcInvalid
		an.Comment = "unknown login"
		return an
	}
	switch req.Action {
	case actionExecute, actionExecuteMQL:
		if req.Position != 0 {
			return b.closePosition(a, req, an)
		}
		return b.openPosition(a, req, an)
	case actionPending, actionPendingMQL:
		return b.placePending(a, req, an)
	case actionModifyPos, actionModifyPosMQL:
		return b.modifyPosition(a, req, an)
	case actionModifyOrder, actionModOrderMQL:
		return b.modifyOrder(a, req, an)
	case actionRemoveOrder, actionRemoveMQL:
		return b.removeOrder(a, req, an)
	}
	an.Retcode = rcInvalid
	return an
}

func validVolume(units int64) bool {
	return units >= volumeMin && units <= volumeMax && units%volumeStep == 0
}

// stopsValid checks SL/TP sit on the correct side of the price a position of
// this direction is valued at. 0 means "no level".
func stopsValid(buy bool, price, sl, tp float64) bool {
	if buy {
		return (sl == 0 || sl < price) && (tp == 0 || tp > price)
	}
	return (sl == 0 || sl > price) && (tp == 0 || tp < price)
}

// market returns the instrument and its quote for an order, or the retcode
// explaining why it cannot trade now.
func (b *demoBroker) market(symbol string) (*instrument, Tick, string) {
	ins := bySymbol[symbol]
	if ins == nil {
		return nil, Tick{}, rcInvalid
	}
	if !ins.tradesAt(sessionClock().Unix()) {
		return ins, Tick{}, rcMarketClosed
	}
	t, ok := b.quote(ins)
	if !ok {
		return ins, Tick{}, rcNoQuotes
	}
	return ins, t, ""
}

func (b *demoBroker) openPosition(a *account, req tradeRequest, an answer) answer {
	if req.Type != typeBuy && req.Type != typeSell {
		an.Retcode = rcInvalidType
		return an
	}
	if !validVolume(req.Volume) {
		an.Retcode = rcInvalidVol
		return an
	}
	ins, t, rc := b.market(req.Symbol)
	if rc != "" {
		an.Retcode = rc
		return an
	}
	buy := req.Type == typeBuy
	price := t.Ask
	if !buy {
		price = t.Bid
	}
	if !stopsValid(buy, price, req.PriceSL, req.PriceTP) {
		an.Retcode = rcInvalidStops
		return an
	}
	if b.summarize(a).MarginFree < b.marginFor(a, ins, req.Volume, price) {
		an.Retcode = rcNoMoney
		return an
	}
	ticket := b.ticket()
	now := time.Now()
	p := &position{Ticket: ticket, Login: a.Login, Symbol: ins.Symbol, Action: req.Type, TimeCreate: now.Unix(),
		PriceOpen: price, PriceSL: req.PriceSL, PriceTP: req.PriceTP, Volume: req.Volume, Comment: req.Comment}
	a.Positions[ticket] = p
	b.record(a, &order{Ticket: ticket, Login: a.Login, Symbol: ins.Symbol, Type: req.Type, State: stateFilled,
		TimeSetup: now.Unix(), TimeDone: now.Unix(), PriceOrder: price, PriceSL: req.PriceSL, PriceTP: req.PriceTP,
		VolumeInitial: req.Volume, PositionID: ticket, Comment: req.Comment})
	b.deal(a, &deal{Order: ticket, Symbol: ins.Symbol, Action: req.Type, Entry: 0, Price: price, Volume: req.Volume,
		TimeMsc: now.UnixMilli(), PositionID: ticket, Comment: req.Comment})
	an.Order, an.Retcode, an.ResultPrice, an.ResultVolume, an.PriceOrder = ticket, rcDone, price, req.Volume, price
	return an
}

// closePosition fills the opposite side against an open position, in full or
// in part, and settles the profit into the balance.
func (b *demoBroker) closePosition(a *account, req tradeRequest, an answer) answer {
	p, ok := a.Positions[req.Position]
	if !ok {
		an.Retcode = rcPosClosed
		return an
	}
	if req.Type != 1-p.Action {
		// A close is the opposite side of the position; anything else is a
		// different request wearing a position id.
		an.Retcode = rcInvalidType
		return an
	}
	vol := req.Volume
	if vol <= 0 || vol > p.Volume {
		vol = p.Volume
	}
	if vol != p.Volume && !validVolume(vol) {
		an.Retcode = rcInvalidVol
		return an
	}
	_, t, rc := b.market(p.Symbol)
	if rc != "" {
		an.Retcode = rc
		return an
	}
	price, ticket := b.settle(a, p, vol, t, req.Comment)
	an.Symbol, an.Order, an.Retcode, an.ResultPrice, an.ResultVolume, an.PriceOrder = p.Symbol, ticket, rcDone, price, vol, price
	return an
}

// settle closes vol of p at the current quote: books the closing order and
// deal, moves the realised profit to the balance and shrinks or removes the
// position. Returns the fill price and the closing order's ticket.
// Caller holds b.mu.
func (b *demoBroker) settle(a *account, p *position, vol int64, t Tick, comment string) (float64, int64) {
	price := t.Bid
	closeType := typeSell
	if p.Action == typeSell {
		price, closeType = t.Ask, typeBuy
	}
	share := float64(vol) / float64(p.Volume)
	profit := b.floatingProfit(&position{Symbol: p.Symbol, Action: p.Action, PriceOpen: p.PriceOpen, Volume: vol}, t)
	storage := round2(p.Storage * share)
	commission := round2(p.Commission * share)
	now := time.Now()
	ticket := b.ticket()
	b.record(a, &order{Ticket: ticket, Login: a.Login, Symbol: p.Symbol, Type: closeType, State: stateFilled,
		TimeSetup: now.Unix(), TimeDone: now.Unix(), PriceOrder: price, VolumeInitial: vol, PositionID: p.Ticket, Comment: comment})
	b.deal(a, &deal{Order: ticket, Symbol: p.Symbol, Action: closeType, Entry: 1, Price: price, Volume: vol,
		TimeMsc: now.UnixMilli(), Profit: profit, Storage: storage, Commission: commission, PositionID: p.Ticket, Comment: comment})
	b.credit(a, profit+storage+commission)
	if vol >= p.Volume {
		delete(a.Positions, p.Ticket)
	} else {
		p.Volume -= vol
		p.Storage = round2(p.Storage - storage)
		p.Commission = round2(p.Commission - commission)
	}
	return price, ticket
}

// credit moves realised money into the balance and mirrors it to the user
// store, which is what the CRM's account list reports.
func (b *demoBroker) credit(a *account, amount float64) {
	a.Balance = round2(a.Balance + amount)
	if err := b.users.SetBalance(context.Background(), a.Login, a.Balance); err != nil {
		log.Printf("broker: balance of %d not written to the user store: %v", a.Login, err)
	}
}

// pendingPriceValid enforces where each pending type may rest relative to
// the market: a limit improves on it, a stop waits beyond it.
func pendingPriceValid(typ int, price float64, t Tick) bool {
	switch typ {
	case typeBuyLimit:
		return price > 0 && price < t.Ask
	case typeSellLimit:
		return price > 0 && price > t.Bid
	case typeBuyStop, typeBuyStopLimit:
		return price > 0 && price > t.Ask
	case typeSellStop, typeSellStopLimit:
		return price > 0 && price < t.Bid
	}
	return false
}

func isBuyType(typ int) bool { return typ%2 == 0 }

func (b *demoBroker) placePending(a *account, req tradeRequest, an answer) answer {
	if req.Type < typeBuyLimit || req.Type > typeSellStopLimit {
		an.Retcode = rcInvalidType
		return an
	}
	if !validVolume(req.Volume) {
		an.Retcode = rcInvalidVol
		return an
	}
	ins, t, rc := b.market(req.Symbol)
	if rc != "" {
		an.Retcode = rc
		return an
	}
	// A stop-limit rests at its trigger and fills at PriceOrder once touched;
	// plain types trigger at PriceOrder itself.
	trigger := req.PriceOrder
	if req.Type == typeBuyStopLimit || req.Type == typeSellStopLimit {
		if req.PriceTrigger > 0 {
			trigger = req.PriceTrigger
		}
	}
	if !pendingPriceValid(req.Type, trigger, t) {
		an.Retcode = rcInvalidPrice
		return an
	}
	if !stopsValid(isBuyType(req.Type), req.PriceOrder, req.PriceSL, req.PriceTP) {
		an.Retcode = rcInvalidStops
		return an
	}
	if (req.TypeTime == timeSpecified || req.TypeTime == timeSpecDay) && req.TimeExpiration > 0 && req.TimeExpiration <= time.Now().Unix() {
		an.Retcode = "10022 Invalid expiration"
		return an
	}
	ticket := b.ticket()
	o := &order{Ticket: ticket, Login: a.Login, Symbol: ins.Symbol, Type: req.Type, State: statePlaced, TimeSetup: time.Now().Unix(),
		PriceOrder: ins.round(req.PriceOrder), PriceTrigger: ins.round(trigger), PriceSL: req.PriceSL, PriceTP: req.PriceTP,
		VolumeInitial: req.Volume, VolumeCurrent: req.Volume, TypeTime: req.TypeTime, TimeExpiration: req.TimeExpiration, Comment: req.Comment}
	if o.TypeTime == timeGTC {
		o.TimeExpiration = 0
	}
	a.Orders[ticket] = o
	b.dirty = true
	an.Order, an.Retcode, an.PriceOrder = ticket, rcPlaced, o.PriceOrder
	return an
}

func (b *demoBroker) modifyPosition(a *account, req tradeRequest, an answer) answer {
	p, ok := a.Positions[req.Position]
	if !ok {
		an.Retcode = rcPosClosed
		return an
	}
	ins, t, rc := b.market(p.Symbol)
	if rc != "" {
		an.Retcode = rc
		return an
	}
	price := t.Bid
	if p.Action == typeSell {
		price = t.Ask
	}
	if !stopsValid(p.Action == typeBuy, price, req.PriceSL, req.PriceTP) {
		an.Retcode = rcInvalidStops
		return an
	}
	if p.PriceSL == req.PriceSL && p.PriceTP == req.PriceTP {
		an.Retcode = rcNoChanges
		return an
	}
	p.PriceSL, p.PriceTP = ins.round(req.PriceSL), ins.round(req.PriceTP)
	b.dirty = true
	an.Symbol, an.Order, an.Retcode, an.Volume, an.PriceOrder = p.Symbol, p.Ticket, rcDone, p.Volume, p.PriceOpen
	return an
}

func (b *demoBroker) modifyOrder(a *account, req tradeRequest, an answer) answer {
	o, ok := a.Orders[req.Order]
	if !ok {
		an.Retcode = rcInvalid
		an.Comment = "order not found"
		return an
	}
	ins, t, rc := b.market(o.Symbol)
	if rc != "" {
		an.Retcode = rc
		return an
	}
	price := o.PriceOrder
	if req.PriceOrder > 0 {
		price = ins.round(req.PriceOrder)
	}
	trigger := price
	if o.Type == typeBuyStopLimit || o.Type == typeSellStopLimit {
		trigger = o.PriceTrigger
		if req.PriceTrigger > 0 {
			trigger = ins.round(req.PriceTrigger)
		}
	}
	if !pendingPriceValid(o.Type, trigger, t) {
		an.Retcode = rcInvalidPrice
		return an
	}
	if !stopsValid(isBuyType(o.Type), price, req.PriceSL, req.PriceTP) {
		an.Retcode = rcInvalidStops
		return an
	}
	vol := o.VolumeCurrent
	if req.Volume > 0 {
		if !validVolume(req.Volume) {
			an.Retcode = rcInvalidVol
			return an
		}
		vol = req.Volume
	}
	o.PriceOrder, o.PriceTrigger, o.PriceSL, o.PriceTP = price, trigger, ins.round(req.PriceSL), ins.round(req.PriceTP)
	o.VolumeInitial, o.VolumeCurrent = vol, vol
	if req.TypeTime != 0 || req.TimeExpiration != 0 {
		o.TypeTime, o.TimeExpiration = req.TypeTime, req.TimeExpiration
		if o.TypeTime == timeGTC {
			o.TimeExpiration = 0
		}
	}
	b.dirty = true
	an.Symbol, an.Order, an.Type, an.Volume, an.PriceOrder, an.Retcode = o.Symbol, o.Ticket, o.Type, vol, price, rcDone
	return an
}

func (b *demoBroker) removeOrder(a *account, req tradeRequest, an answer) answer {
	o, ok := a.Orders[req.Order]
	if !ok {
		an.Retcode = rcInvalid
		an.Comment = "order not found"
		return an
	}
	b.finishOrder(a, o, stateCanceled)
	an.Symbol, an.Order, an.Type, an.Volume, an.PriceOrder, an.Retcode = o.Symbol, o.Ticket, o.Type, o.VolumeInitial, o.PriceOrder, rcDone
	return an
}

// finishOrder moves a working order to history in a final state.
func (b *demoBroker) finishOrder(a *account, o *order, state int) {
	delete(a.Orders, o.Ticket)
	o.State = state
	o.TimeDone = time.Now().Unix()
	if state != stateFilled {
		o.VolumeCurrent = o.VolumeInitial
	}
	b.record(a, o)
}

func (b *demoBroker) record(a *account, o *order) {
	a.History = append(a.History, o)
	b.dirty = true
}

func (b *demoBroker) deal(a *account, d *deal) {
	d.Ticket = b.ticket()
	d.Login = a.Login
	a.Deals = append(a.Deals, d)
	b.dirty = true
}

// ── Engine loop: stops, targets, pending triggers, expiry, stop-out ─────────

// Run evaluates every account against the market until ctx ends.
func (b *demoBroker) Run(ctx context.Context) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	saver := time.NewTicker(time.Second)
	defer saver.Stop()
	for {
		select {
		case <-ctx.Done():
			b.save()
			return
		case <-ticker.C:
			b.evaluate()
		case <-saver.C:
			b.save()
		}
	}
}

func (b *demoBroker) evaluate() {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	for _, a := range b.accounts {
		b.checkStops(a)
		b.checkPending(a, now)
		b.checkStopOut(a)
	}
}

// checkStops closes positions whose stop loss or take profit the market has
// touched. Buys are valued at bid, sells at ask — the price a close fills at.
func (b *demoBroker) checkStops(a *account) {
	for _, p := range sortedPositions(a) {
		ins := bySymbol[p.Symbol]
		if ins == nil || !ins.tradesAt(sessionClock().Unix()) {
			continue
		}
		t, ok := b.quote(ins)
		if !ok {
			continue
		}
		var hit string
		if p.Action == typeBuy {
			if p.PriceSL > 0 && t.Bid <= p.PriceSL {
				hit = "[sl]"
			} else if p.PriceTP > 0 && t.Bid >= p.PriceTP {
				hit = "[tp]"
			}
		} else {
			if p.PriceSL > 0 && t.Ask >= p.PriceSL {
				hit = "[sl]"
			} else if p.PriceTP > 0 && t.Ask <= p.PriceTP {
				hit = "[tp]"
			}
		}
		if hit == "" {
			continue
		}
		price, ticket := b.settle(a, p, p.Volume, t, hit)
		log.Printf("broker: login %d %s %s position %d closed by %s at %s (order %d)", a.Login, p.Symbol, sideName(p.Action), p.Ticket, hit, ftoa(price, ins.Digits), ticket)
	}
}

// checkPending fills working orders the market has reached and expires the
// ones past their lifetime.
func (b *demoBroker) checkPending(a *account, now time.Time) {
	for _, o := range sortedOrders(a) {
		if expired(o, now) {
			b.finishOrder(a, o, stateExpired)
			log.Printf("broker: login %d order %d expired", a.Login, o.Ticket)
			continue
		}
		ins := bySymbol[o.Symbol]
		if ins == nil || !ins.tradesAt(sessionClock().Unix()) {
			continue
		}
		t, ok := b.quote(ins)
		if !ok {
			continue
		}
		switch o.Type {
		case typeBuyStopLimit:
			if t.Ask >= o.PriceTrigger {
				o.Type = typeBuyLimit // triggered: now rests as a limit
				b.dirty = true
			}
			continue
		case typeSellStopLimit:
			if t.Bid <= o.PriceTrigger {
				o.Type = typeSellLimit
				b.dirty = true
			}
			continue
		}
		var fill float64
		switch o.Type {
		case typeBuyLimit:
			if t.Ask <= o.PriceOrder {
				fill = math.Min(t.Ask, o.PriceOrder)
			}
		case typeSellLimit:
			if t.Bid >= o.PriceOrder {
				fill = math.Max(t.Bid, o.PriceOrder)
			}
		case typeBuyStop:
			if t.Ask >= o.PriceOrder {
				fill = t.Ask
			}
		case typeSellStop:
			if t.Bid <= o.PriceOrder {
				fill = t.Bid
			}
		}
		if fill == 0 {
			continue
		}
		side := typeBuy
		if !isBuyType(o.Type) {
			side = typeSell
		}
		if b.summarize(a).MarginFree < b.marginFor(a, ins, o.VolumeCurrent, fill) {
			b.finishOrder(a, o, stateRejected)
			o.Comment = "no money"
			log.Printf("broker: login %d order %d rejected at trigger: insufficient margin", a.Login, o.Ticket)
			continue
		}
		p := &position{Ticket: o.Ticket, Login: a.Login, Symbol: o.Symbol, Action: side, TimeCreate: now.Unix(),
			PriceOpen: fill, PriceSL: o.PriceSL, PriceTP: o.PriceTP, Volume: o.VolumeCurrent, Comment: o.Comment}
		a.Positions[p.Ticket] = p
		o.PositionID = p.Ticket
		o.VolumeCurrent = 0
		b.finishOrder(a, o, stateFilled)
		b.deal(a, &deal{Order: o.Ticket, Symbol: o.Symbol, Action: side, Entry: 0, Price: fill, Volume: p.Volume,
			TimeMsc: now.UnixMilli(), PositionID: p.Ticket, Comment: o.Comment})
		log.Printf("broker: login %d order %d filled: %s %s %.2f lots at %s", a.Login, o.Ticket, sideName(side), o.Symbol, lots(p.Volume), ftoa(fill, ins.Digits))
	}
}

func expired(o *order, now time.Time) bool {
	switch o.TypeTime {
	case timeSpecified, timeSpecDay:
		return o.TimeExpiration > 0 && now.Unix() >= o.TimeExpiration
	case timeDay:
		// Good for the trading day it was placed on (UTC).
		setup := time.Unix(o.TimeSetup, 0).UTC()
		return now.UTC().YearDay() != setup.YearDay() || now.UTC().Year() != setup.Year()
	}
	return false
}

// checkStopOut closes the most losing position, repeatedly, while the margin
// level is at or under the stop-out level.
func (b *demoBroker) checkStopOut(a *account) {
	for i := 0; i < 64; i++ {
		s := b.summarize(a)
		if s.Margin <= 0 || s.MarginLevel > stopOutLevel {
			return
		}
		var worst *position
		var worstPL float64
		var worstTick Tick
		for _, p := range sortedPositions(a) {
			t, ok := b.quote(bySymbol[p.Symbol])
			if !ok {
				continue
			}
			pl := b.floatingProfit(p, t)
			if worst == nil || pl < worstPL {
				worst, worstPL, worstTick = p, pl, t
			}
		}
		if worst == nil {
			return
		}
		price, _ := b.settle(a, worst, worst.Volume, worstTick, "[so]")
		log.Printf("broker: login %d stop-out at margin level %.1f%%: %s position %d closed at %s", a.Login, s.MarginLevel, worst.Symbol, worst.Ticket, ftoa(price, bySymbol[worst.Symbol].Digits))
	}
}

func sortedPositions(a *account) []*position {
	out := make([]*position, 0, len(a.Positions))
	for _, p := range a.Positions {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ticket < out[j].Ticket })
	return out
}

func sortedOrders(a *account) []*order {
	out := make([]*order, 0, len(a.Orders))
	for _, o := range a.Orders {
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ticket < out[j].Ticket })
	return out
}

func sideName(action int) string {
	if action == typeBuy {
		return "buy"
	}
	return "sell"
}

// ── Wire shapes (MT5 Manager API answers) ───────────────────────────────────

func (b *demoBroker) positionJSON(a *account, p *position) string {
	ins := bySymbol[p.Symbol]
	digits := 5
	if ins != nil {
		digits = ins.Digits
	}
	current, profit := p.PriceOpen, 0.0
	if t, ok := b.quote(ins); ok {
		if p.Action == typeBuy {
			current = t.Bid
		} else {
			current = t.Ask
		}
		profit = b.floatingProfit(p, t)
	}
	return fmt.Sprintf(`{"Position":%d,"ExternalID":"","Login":%d,"Symbol":%q,"Action":%d,"TimeCreate":%d,"PriceOpen":%s,"PriceCurrent":%s,"PriceSL":%s,"PriceTP":%s,"Volume":%d,"Profit":%s,"Storage":%s,"Commission":%s,"Comment":%q}`,
		p.Ticket, a.Login, p.Symbol, p.Action, p.TimeCreate, ftoa(p.PriceOpen, digits), ftoa(current, digits), ftoa(p.PriceSL, digits), ftoa(p.PriceTP, digits),
		p.Volume, ftoa(profit, 2), ftoa(p.Storage, 2), ftoa(p.Commission, 2), p.Comment)
}

func orderJSON(o *order) string {
	digits := 5
	if ins := bySymbol[o.Symbol]; ins != nil {
		digits = ins.Digits
	}
	return fmt.Sprintf(`{"Order":"%d","ExternalID":"","Login":%d,"Symbol":%q,"State":%d,"TimeSetup":%d,"TimeDone":%d,"Type":%d,"PriceOrder":%s,"PriceTrigger":%s,"PriceSL":%s,"PriceTP":%s,"VolumeInitial":%d,"VolumeCurrent":%d,"Comment":%q,"TypeTime":%d,"TimeExpiration":%d,"PositionID":"%d"}`,
		o.Ticket, o.Login, o.Symbol, o.State, o.TimeSetup, o.TimeDone, o.Type, ftoa(o.PriceOrder, digits), ftoa(o.PriceTrigger, digits), ftoa(o.PriceSL, digits), ftoa(o.PriceTP, digits),
		o.VolumeInitial, o.VolumeCurrent, o.Comment, o.TypeTime, o.TimeExpiration, o.PositionID)
}

func dealJSON(d *deal) string {
	digits := 5
	if ins := bySymbol[d.Symbol]; ins != nil {
		digits = ins.Digits
	}
	return fmt.Sprintf(`{"Deal":"%d","Order":"%d","Login":%d,"Symbol":%q,"Action":%d,"Entry":%d,"Price":%s,"Volume":%d,"Time":%d,"TimeMsc":%d,"Commission":%s,"Storage":%s,"Profit":%s,"PositionID":"%d","Comment":%q}`,
		d.Ticket, d.Order, d.Login, d.Symbol, d.Action, d.Entry, ftoa(d.Price, digits), d.Volume, d.TimeMsc/1000, d.TimeMsc,
		ftoa(d.Commission, 2), ftoa(d.Storage, 2), ftoa(d.Profit, 2), d.PositionID, d.Comment)
}

// page slices rows for MT5's offset/total paging (total 0 = everything).
func page(rows []string, offset, total int) []string {
	if offset < 0 {
		offset = 0
	}
	if offset > len(rows) {
		return nil
	}
	rows = rows[offset:]
	if total > 0 && total < len(rows) {
		rows = rows[:total]
	}
	return rows
}

// Positions answers /api/position/get_page.
func (b *demoBroker) Positions(login int64, offset, total int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"0 Done","answer":[]}`
	}
	var rows []string
	for _, p := range sortedPositions(a) {
		rows = append(rows, b.positionJSON(a, p))
	}
	return `{"retcode":"0 Done","answer":[` + strings.Join(page(rows, offset, total), ",") + `]}`
}

// Position answers /api/position/get for one login+symbol.
func (b *demoBroker) Position(login int64, symbol string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if ok {
		for _, p := range sortedPositions(a) {
			if strings.EqualFold(p.Symbol, symbol) {
				return `{"retcode":"0 Done","answer":` + b.positionJSON(a, p) + `}`
			}
		}
	}
	return `{"retcode":"13 Not found","answer":null}`
}

// Orders answers /api/order/get_page: the working orders.
func (b *demoBroker) Orders(login int64, offset, total int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"0 Done","answer":[]}`
	}
	var rows []string
	for _, o := range sortedOrders(a) {
		rows = append(rows, orderJSON(o))
	}
	return `{"retcode":"0 Done","answer":[` + strings.Join(page(rows, offset, total), ",") + `]}`
}

// Order answers /api/order/get?ticket= from working orders or history.
func (b *demoBroker) Order(ticket int64) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, a := range b.accounts {
		if o, ok := a.Orders[ticket]; ok {
			return `{"retcode":"0 Done","answer":` + orderJSON(o) + `}`
		}
		for _, o := range a.History {
			if o.Ticket == ticket {
				return `{"retcode":"0 Done","answer":` + orderJSON(o) + `}`
			}
		}
	}
	return `{"retcode":"13 Not found","answer":null}`
}

// History answers /api/history/get_page: orders in a final state whose
// TimeDone falls in [from, to] (0 = unbounded).
func (b *demoBroker) History(login int64, from, to int64, offset, total int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"0 Done","answer":[]}`
	}
	var rows []string
	for _, o := range a.History {
		if (from > 0 && o.TimeDone < from) || (to > 0 && o.TimeDone > to) {
			continue
		}
		rows = append(rows, orderJSON(o))
	}
	return `{"retcode":"0 Done","answer":[` + strings.Join(page(rows, offset, total), ",") + `]}`
}

// Deals answers /api/deal/get_page over [from, to] in unix seconds.
func (b *demoBroker) Deals(login int64, from, to int64, offset, total int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"0 Done","answer":[]}`
	}
	var rows []string
	for _, d := range a.Deals {
		sec := d.TimeMsc / 1000
		if (from > 0 && sec < from) || (to > 0 && sec > to) {
			continue
		}
		rows = append(rows, dealJSON(d))
	}
	return `{"retcode":"0 Done","answer":[` + strings.Join(page(rows, offset, total), ",") + `]}`
}

// Account answers /api/user/account/get with the live margin figures.
func (b *demoBroker) Account(login int64) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"13 Not found","answer":null}`
	}
	s := b.summarize(a)
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Login":"%d","Currency":%q,"Balance":%s,"Credit":%s,"Equity":%s,"Profit":%s,"Margin":%s,"MarginFree":%s,"MarginLevel":%s,"MarginLeverage":%d,"Assets":0,"Liabilities":0}}`,
		login, a.Currency, ftoa(s.Balance, 2), ftoa(s.Credit, 2), ftoa(s.Equity, 2), ftoa(s.Profit, 2), ftoa(s.Margin, 2), ftoa(s.MarginFree, 2), ftoa(s.MarginLevel, 2), a.Leverage)
}

// User answers /api/user/get: the MT5 user record (leverage, rights, group).
// Rights 483 = enabled + password change + trailing + expert + API + reports:
// a normal trading account, never investor/read-only.
func (b *demoBroker) User(login int64, name string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"13 Not found","answer":null}`
	}
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Login":"%d","ID":"%d","Name":%q,"Group":"demo\\forex-hedge-usd","Leverage":"%d","Rights":"483","Currency":%q,"Balance":%s,"Credit":%s}}`,
		login, login, name, a.Leverage, a.Currency, ftoa(a.Balance, 2), ftoa(a.Credit, 2))
}

// UpdateUser answers /api/user/update: only the leverage is writable.
func (b *demoBroker) UpdateUser(body []byte) string {
	var rec map[string]json.RawMessage
	if err := json.Unmarshal(body, &rec); err != nil {
		return `{"retcode":"3 Invalid parameters"}`
	}
	get := func(name string) string {
		for k, v := range rec {
			if strings.EqualFold(k, name) {
				return strings.Trim(strings.TrimSpace(string(v)), `"`)
			}
		}
		return ""
	}
	login, _ := strconv.ParseInt(get("Login"), 10, 64)
	lev, _ := strconv.Atoi(get("Leverage"))
	if lev <= 0 {
		lev, _ = strconv.Atoi(get("MarginLeverage"))
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"13 Not found"}`
	}
	if lev > 0 && lev != a.Leverage {
		a.Leverage = lev
		b.dirty = true
		log.Printf("broker: login %d leverage set to 1:%d", login, lev)
	}
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Login":"%d","Leverage":"%d"}}`, login, a.Leverage)
}

// CheckMargin answers /api/trade/check_margin.
func (b *demoBroker) CheckMargin(login int64, symbol string, typ int, units int64, price float64) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	ins := bySymbol[symbol]
	if !ok || ins == nil {
		return `{"retcode":"13 Not found","answer":null}`
	}
	if price <= 0 {
		if t, ok := b.quote(ins); ok {
			price = t.Ask
			if typ == typeSell {
				price = t.Bid
			}
		}
	}
	s := b.summarize(a)
	need := b.marginFor(a, ins, units, price)
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Login":"%d","Symbol":%q,"Margin":%s,"MarginFree":%s,"MarginLevel":%s,"MarginRequired":%s,"Enough":%t}}`,
		login, symbol, ftoa(s.Margin, 2), ftoa(s.MarginFree, 2), ftoa(s.MarginLevel, 2), ftoa(need, 2), s.MarginFree >= need)
}

// CalcProfit answers /api/trade/calc_profit.
func (b *demoBroker) CalcProfit(symbol string, typ int, units int64, open, close float64) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	ins := bySymbol[symbol]
	if ins == nil {
		return `{"retcode":"13 Not found","answer":null}`
	}
	diff := close - open
	if typ == typeSell {
		diff = open - close
	}
	profit := round2(b.toUSD(ins.Profit, diff*lots(units)*ins.contract()))
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Symbol":%q,"Profit":%s}}`, symbol, ftoa(profit, 2))
}

// Balance answers /api/trade/balance: a deposit or withdrawal on the demo
// account (type 2 = balance).
func (b *demoBroker) Balance(login int64, amount float64, comment string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return `{"retcode":"13 Not found","answer":null}`
	}
	if amount < 0 && b.summarize(a).MarginFree+amount < 0 {
		return `{"retcode":"10019 No money","answer":null}`
	}
	b.credit(a, amount)
	b.deal(a, &deal{Login: login, Action: 2, Entry: 0, Profit: round2(amount), TimeMsc: time.Now().UnixMilli(), Comment: comment})
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Login":"%d","Balance":%s}}`, login, ftoa(a.Balance, 2))
}

// PositionCount answers /api/position/get_total.
func (b *demoBroker) PositionCount(login int64) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if a, ok := b.acct(login); ok {
		return len(a.Positions)
	}
	return 0
}

// OrderCount answers /api/order/get_total.
func (b *demoBroker) OrderCount(login int64) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if a, ok := b.acct(login); ok {
		return len(a.Orders)
	}
	return 0
}

// AccountFigures is the live snapshot the CRM's account list carries.
type AccountFigures struct {
	Equity, Margin, MarginFree float64
	Leverage                   int
	Positions, Orders          int
}

// Summary reports an account's live figures; a login the CRM does not know
// answers zeros.
func (b *demoBroker) Summary(login int64) AccountFigures {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return AccountFigures{}
	}
	s := b.summarize(a)
	return AccountFigures{Equity: s.Equity, Margin: s.Margin, MarginFree: s.MarginFree, Leverage: a.Leverage, Positions: len(a.Positions), Orders: len(a.Orders)}
}

// Reset empties an account's book — positions, working orders, history and
// deals — and refunds it to balance. The admin's way to hand a demo account
// back in its starting state.
func (b *demoBroker) Reset(login int64, balance float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	a, ok := b.acct(login)
	if !ok {
		return
	}
	a.Positions, a.Orders, a.History, a.Deals = map[int64]*position{}, map[int64]*order{}, nil, nil
	a.Leverage = defaultLeverage
	a.Balance = balance
	b.dirty = true
	if err := b.users.SetBalance(context.Background(), login, balance); err != nil {
		log.Printf("broker: reset balance of %d not written to the user store: %v", login, err)
	}
	log.Printf("broker: login %d reset to %.2f", login, balance)
}
