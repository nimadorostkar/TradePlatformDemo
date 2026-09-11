package transform

import "encoding/json"

// Upstream MT5 DTOs — only the fields the transforms read. Numeric fields use
// the lenient Float/Int/Int64 types because the MT5 Manager Web API returns
// numbers as JSON strings (see jsonnum.go). Go's encoding/json matches keys
// case-insensitively, so the PascalCase tags bind regardless of casing.

// ── Order / History ──────────────────────────────────────────────────────────

type OrderHistory struct {
	Retcode string               `json:"retcode"`
	Answer  []OrderHistoryAnswer `json:"answer"`
}

type OrderHistoryAnswer struct {
	Order     string `json:"Order"`
	Symbol    string `json:"Symbol"`
	State     Int    `json:"State"`
	TimeSetup Int    `json:"TimeSetup"`
	// TimeDone is when the order reached its FINAL state — filled, cancelled,
	// rejected or expired. MT5 leaves it 0 while an order is still working.
	TimeDone         Int    `json:"TimeDone"`
	Type             Int    `json:"Type"`
	PriceOrder       Float  `json:"PriceOrder"`
	PriceSL          Float  `json:"PriceSL"`
	PriceTP          Float  `json:"PriceTP"`
	VolumeInitial    Float  `json:"VolumeInitial"`
	VolumeCurrent    Float  `json:"VolumeCurrent"`
	VolumeInitialExt Float  `json:"VolumeInitialExt"`
	VolumeCurrentExt Float  `json:"VolumeCurrentExt"`
	Comment          string `json:"Comment"`
	Side             Int    `json:"side"`
	// TypeTime is the MT5 ORDER_TIME_* enum and TimeExpiration the GTD deadline
	// (unix seconds, 0 = no expiry). Both drive the TV `duration` block.
	TypeTime       Int   `json:"TypeTime"`
	TimeExpiration Int64 `json:"TimeExpiration"`
}

// ── Position ─────────────────────────────────────────────────────────────────

type PositiongetResponse struct {
	Retcode string         `json:"retcode"`
	Answer  PositionAnswer `json:"answer"`
}

type PositionResponse struct {
	Retcode string           `json:"retcode"`
	Answer  []PositionAnswer `json:"answer"`
}

type PositionAnswer struct {
	Position     Int    `json:"Position"`
	ExternalID   string `json:"ExternalID"`
	Login        Int    `json:"Login"`
	Symbol       string `json:"Symbol"`
	Action       Int    `json:"Action"`
	TimeCreate   Int64  `json:"TimeCreate"`
	PriceOpen    Float  `json:"PriceOpen"`
	PriceCurrent Float  `json:"PriceCurrent"`
	PriceSL      Float  `json:"PriceSL"`
	PriceTP      Float  `json:"PriceTP"`
	Volume       Int    `json:"Volume"`
	VolumeExt    Float  `json:"VolumeExt"`
	Profit       Float  `json:"Profit"`
	// Storage is MT5's accumulated swap and Commission the accrued commission.
	// Both are POINTERS on purpose: a trader reconciling costs reads a real 0
	// and a field the broker did not send as different facts, so an absent
	// field must serialize as null rather than as 0. (IMTPosition carries
	// Storage on every build; Commission only on builds that expose it.)
	Storage    *Float `json:"Storage"`
	Commission *Float `json:"Commission"`
}

// ── Deal (per-fill feed) ─────────────────────────────────────────────────────

type DealPageResponse struct {
	Retcode string       `json:"retcode"`
	Answer  []DealAnswer `json:"answer"`
}

// DealAnswer carries the IMTDeal fields the execution feed reads. Volume is in
// 1/10000 lot and VolumeExt in 1/100000000 lot (see volume.go).
type DealAnswer struct {
	Deal       string `json:"Deal"`
	Order      string `json:"Order"`
	Login      Int64  `json:"Login"`
	Symbol     string `json:"Symbol"`
	Action     Int    `json:"Action"`
	Entry      Int    `json:"Entry"`
	Price      Float  `json:"Price"`
	Volume     Float  `json:"Volume"`
	VolumeExt  Float  `json:"VolumeExt"`
	Time       Int64  `json:"Time"`
	TimeMsc    Int64  `json:"TimeMsc"`
	Commission Float  `json:"Commission"`
	Storage    Float  `json:"Storage"`
	Profit     Float  `json:"Profit"`
	PositionID string `json:"PositionID"`
	Comment    string `json:"Comment"`
}

// ── User ─────────────────────────────────────────────────────────────────────

type MT5UserResponse struct {
	Retcode string        `json:"retcode"`
	Answer  MT5UserAnswer `json:"answer"`
}

type MT5UserAnswer struct {
	ID   string `json:"ID"`
	Name string `json:"Name"`
}

type AccountSummaryRoot struct {
	Retcode string               `json:"retcode"`
	Answer  AccountSummaryAnswer `json:"answer"`
}

type AccountSummaryAnswer struct {
	Login   string `json:"Login"`
	Balance Float  `json:"Balance"`
	Equity  Float  `json:"Equity"`
	Profit  Float  `json:"Profit"`
}

// ── Modify order (UpdateOrder) ───────────────────────────────────────────────

type MT5ModifyOrder struct {
	Retcode string                 `json:"retcode"`
	Answer  MT5ModifyOrderResponse `json:"answer"`
}

type MT5ModifyOrderResponse struct {
	Order         Int    `json:"Order"`
	ExternalID    string `json:"ExternalID"`
	Login         Int    `json:"Login"`
	Symbol        string `json:"Symbol"`
	PriceOrder    Float  `json:"PriceOrder"`
	PriceSL       Float  `json:"PriceSL"`
	PriceTP       Float  `json:"PriceTP"`
	VolumeInitial Int    `json:"VolumeInitial"`
}

// ── Symbol ───────────────────────────────────────────────────────────────────

type SymbolByMaskRoot struct {
	Retcode string               `json:"retcode"`
	Answer  []SymbolByNameAnswer `json:"answer"`
}

type SymbolByAnswerRoot struct {
	Retcode string             `json:"retcode"`
	Answer  SymbolByNameAnswer `json:"answer"`
}

// SymbolByNameAnswer carries only the fields the TV symbol transform reads.
// The VolumeXxx fields are in 1/10000 lot and the VolumeXxxExt fields in
// 1/100000000 lot — never lots. Use LotsPreferExt to read them.
type SymbolByNameAnswer struct {
	Symbol         string      `json:"Symbol"`
	Path           string      `json:"Path"`
	Description    string      `json:"Description"`
	Sector         string      `json:"Sector"`
	Industry       string      `json:"Industry"`
	CurrencyBase   string      `json:"CurrencyBase"`
	Multiply       Float       `json:"Multiply"`
	Digits         Int         `json:"Digits"`
	VolumeMin      Int         `json:"VolumeMin"`
	VolumeMax      Float       `json:"VolumeMax"`
	VolumeStep     Float       `json:"VolumeStep"`
	VolumeMinExt   Int         `json:"VolumeMinExt"`
	VolumeMaxExt   Float       `json:"VolumeMaxExt"`
	VolumeStepExt  Float       `json:"VolumeStepExt"`
	SessionsTrades [][]Session `json:"SessionsTrades"`
}

type Session struct {
	Open  Int `json:"Open"`
	Close Int `json:"Close"`
}

type MT5SymbolList struct {
	Retcode string   `json:"retcode"`
	Answer  []string `json:"answer"`
}

// ── Tick / chart ─────────────────────────────────────────────────────────────

type TicklastRoot struct {
	Retcode string           `json:"retcode"`
	TransID string           `json:"trans_id"`
	Answer  []TicklastAnswer `json:"answer"`
}

type TicklastAnswer struct {
	Symbol string `json:"Symbol"`
	// Datetime is whole seconds on the broker's clock; DatetimeMsc is the same
	// instant in milliseconds when the broker publishes it. Prefer the latter
	// when reading the broker clock — it is the more precise of the two.
	Datetime    string `json:"Datetime"`
	DatetimeMsc string `json:"DatetimeMsc"`
	Bid         Float  `json:"Bid"`
	Ask         Float  `json:"Ask"`
	Last        Float  `json:"Last"`
	Volume      Float  `json:"Volume"`
}

// TickChartResponse is the /api/chart/get payload: answer is an array of
// [time, open, high, low, close] rows (numbers or numeric strings).
type TickChartResponse struct {
	Retcode string    `json:"retcode"`
	Answer  [][]Float `json:"answer"`
}

// ── Trade (send_request) ─────────────────────────────────────────────────────

type FinalAnswer struct {
	Retcode string          `json:"retcode"`
	Answer  FinalAnswerBody `json:"answer"`
}

type FinalAnswerBody struct {
	ID Int64 `json:"Id"`
}

// RootObject is the get_request_result payload: answer is a map of lists of
// AnswerDetail. PlaceOrderAnswer = answer.Values[0][1].answer (ANALYSIS §7.6).
type RootObject struct {
	Retcode string                    `json:"retcode"`
	Answer  map[string][]AnswerDetail `json:"answer"`
}

type AnswerDetail struct {
	Result json.RawMessage   `json:"result"`
	Answer *PlaceOrderAnswer `json:"answer"`
}

type PlaceOrderAnswer struct {
	Order          string `json:"Order"`
	ExternalID     string `json:"ExternalID"`
	Symbol         string `json:"Symbol"`
	Type           string `json:"Type"`
	Volume         Float  `json:"Volume"`
	PriceOrder     Float  `json:"PriceOrder"`
	PriceSL        Float  `json:"PriceSL"`
	PriceTP        Float  `json:"PriceTP"`
	Comment        string `json:"Comment"`
	ResultRetcode  string `json:"ResultRetcode"`
	ResultPrice    Float  `json:"ResultPrice"`
	ResultVolume   Float  `json:"ResultVolume"`
	TypeTime       Int    `json:"TypeTime"`
	TimeExpiration Int64  `json:"TimeExpiration"`
}
