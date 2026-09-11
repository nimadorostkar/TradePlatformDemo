package transform

// TradingView ("TV") output models. JSON tags reproduce the exact .NET property
// casing and declaration order. Pointer fields are those the .NET DTO leaves as
// null (C# nullable / reference types never assigned) so they serialize as JSON
// null rather than a zero value.

// TVOrderHistory — Models/MT5/Order/tv/TVOrderHistory.cs. The trailing block
// (qtyLots…typeTime) is additive: the original fields keep their .NET values and
// units, and the new ones state what those numbers mean without ambiguity.
type TVOrderHistory struct {
	ID               string         `json:"id"`
	Symbol           string         `json:"symbol"`
	Side             int            `json:"side"`
	Type             int            `json:"type"`
	Qty              float64        `json:"qty"`
	LimitPrice       float64        `json:"limitPrice"`
	StopPrice        float64        `json:"stopPrice"`
	Last             float64        `json:"last"`
	Execution        *string        `json:"execution"`
	Status           int            `json:"status"`
	StopLoss         float64        `json:"stopLoss"`
	TrailingStopPips *int           `json:"trailingStopPips"`
	StopType         *int           `json:"stopType"`
	TakeProfit       float64        `json:"takeProfit"`
	Duration         *OrderDuration `json:"duration"`
	CustomFields     *string        `json:"customFields"`
	FilledQty        float64        `json:"filledQty"`
	AvgPrice         *int           `json:"avgPrice"`
	UpdateTime       int            `json:"updateTime"`
	Message          string         `json:"message"`
	TimeSetup        *int64         `json:"timeSetup"`
	// TimeDone is when the order reached its final state, in unix seconds, or
	// null while it is still working. `updateTime` carries the same instant for
	// TradingView's benefit; this states it unambiguously, so a consumer can
	// tell "not finished yet" from "finished at the moment it was placed".
	TimeDone *int64 `json:"timeDone"`
	// QtyLots / FilledQtyLots are qty and filledQty in LOTS (qty itself is in
	// MT5's 1/10000 lot). See docs/VOLUME-UNITS.md.
	QtyLots       float64 `json:"qtyLots"`
	FilledQtyLots float64 `json:"filledQtyLots"`
	// Expiration is the GTD deadline in unix seconds; 0 means "no expiry"
	// (good till cancelled). TypeTime is the raw MT5 ORDER_TIME_* enum.
	Expiration int64 `json:"expiration"`
	TypeTime   int   `json:"typeTime"`
}

// TVPositionResponse — Models/MT5/Position/TVPositionResponse.cs.
//
// Swap and Commission are pointers so an absent value serializes as null: a
// trader reconciling costs must be able to tell a real zero from a number the
// broker never sent, and rendering "0" for the latter is a lie about their P&L.
type TVPositionResponse struct {
	ID     int     `json:"Id"`
	Profit float64 `json:"profit"`
	Qty    int     `json:"qty"`
	Side   int     `json:"side"`
	Symbol string  `json:"symbol"`
	Type   int     `json:"type"`
	Last   float64 `json:"last"`
	Price  float64 `json:"price"`
	// QtyLots is qty in LOTS (qty is in MT5's 1/10000 lot).
	QtyLots    float64  `json:"qtyLots"`
	Swap       *float64 `json:"swap"`
	Commission *float64 `json:"commission"`
	TimeCreate *int64   `json:"timeCreate"`
	PriceSL    *float64 `json:"priceSL"`
	PriceTP    *float64 `json:"priceTP"`
}

// UpdatePositionResponse — Models/MT5/Position/TVPositionResponse.cs
type UpdatePositionResponse struct {
	Position      int     `json:"Position"`
	ExternalID    string  `json:"ExternalID"`
	Login         int     `json:"Login"`
	Symbol        string  `json:"symbol"`
	PriceSL       float64 `json:"priceSL"`
	PriceTP       float64 `json:"priceTP"`
	VolumeInitial int     `json:"volumeInitial"`
}

// TVResponseModifyOrder — Models/tv/Order/TVResponseModifyOrder.cs
type TVResponseModifyOrder struct {
	Order         int     `json:"Order"`
	ExternalID    string  `json:"ExternalID"`
	Login         int     `json:"Login"`
	Symbol        string  `json:"symbol"`
	PriceOrder    float64 `json:"priceOrder"`
	PriceSL       float64 `json:"priceSL"`
	PriceTP       float64 `json:"priceTP"`
	VolumeInitial int     `json:"volumeInitial"`
}

// TVUserResponse — Models/MT5/User/TVUserResponse.cs
type TVUserResponse struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	Currency     *string `json:"currency"`
	CurrencySign *string `json:"currencysign"`
}

// TVAccountSummary — Models/MT5/User/TVUserResponse.cs
type TVAccountSummary struct {
	Title   string  `json:"title"`
	Balance float64 `json:"balance"`
	Equity  float64 `json:"equity"`
	PL      float64 `json:"pl"`
}

// TVTickResponse — Models/MT5/Tick/TVTickResponse.cs
type TVTickResponse struct {
	Time   int64   `json:"time"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume *int    `json:"volume"`
}

// Quote — Models/MT5/Tick/TVTickResponse.cs
type Quote struct {
	SymbolName string  `json:"symbolname"`
	Status     string  `json:"status"`
	Bid        float64 `json:"bid"`
	Ask        float64 `json:"ask"`
	LastPrice  float64 `json:"lastprice"`
	Volume     float64 `json:"volume"`
	// Time is when the broker printed this quote, in UTC unix seconds — the
	// same base as every bar `time`. A quote without it cannot be placed on the
	// chart's axis, which leaves a client building the forming candle from its
	// own clock and no way to tell a fresh tick from a stale one.
	Time int64 `json:"time"`
}

// OrderDuration — Models/tv/PlacedOrder.cs
type OrderDuration struct {
	Datetime *float64 `json:"datetime"`
	Type     *string  `json:"type"`
}

// PlacedOrder — Models/tv/PlacedOrder.cs. This is the ONE shape
// `POST /api/Trade/send_request` returns for `source=tv`, and the fields from
// resultRetcode down make MT5's own verdict explicit so no consumer has to
// infer acceptance from the presence of an id or from `status`.
type PlacedOrder struct {
	AvgPrice         *float64       `json:"avgPrice"`
	CustomFields     any            `json:"customFields"`
	Duration         *OrderDuration `json:"duration"`
	FilledQty        *float64       `json:"filledQty"`
	ID               string         `json:"id"`
	LimitPrice       *float64       `json:"limitPrice"`
	Message          string         `json:"message"`
	Qty              float64        `json:"qty"`
	Side             int            `json:"side"`
	Status           int            `json:"status"`
	StopLoss         *float64       `json:"stopLoss"`
	StopPrice        *float64       `json:"stopPrice"`
	StopType         int            `json:"stopType"`
	Symbol           string         `json:"symbol"`
	TakeProfit       *float64       `json:"takeProfit"`
	TrailingStopPips *float64       `json:"trailingStopPips"`
	Type             int            `json:"type"`
	UpdateTime       *float64       `json:"updateTime"`

	// ResultRetcode is MT5's raw verdict ("10009 Done"); it is ALWAYS present
	// on this shape. Outcome is its parsed tri-state
	// (accepted / rejected / unknown) and RetcodeDescription its meaning.
	ResultRetcode      string       `json:"resultRetcode"`
	Outcome            TradeOutcome `json:"outcome"`
	RetcodeDescription string       `json:"retcodeDescription"`
	// QtyLots / FilledQtyLots are qty and filledQty in LOTS.
	QtyLots       float64  `json:"qtyLots"`
	FilledQtyLots *float64 `json:"filledQtyLots"`
	// Expiration is the GTD deadline in unix seconds (0 = good till cancelled);
	// TypeTime is the raw MT5 ORDER_TIME_* enum.
	Expiration int64 `json:"expiration"`
	TypeTime   int   `json:"typeTime"`
}

// TVSymbolResponse — Models/MT5/Symbol/TVSymbolResponse.cs. The constant
// defaults below are emitted verbatim and must appear in output.
type TVSymbolResponse struct {
	Ticker               string   `json:"ticker"`
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	Type                 string   `json:"type"`
	Session              string   `json:"session"`
	Timezone             string   `json:"timezone"`
	Exchange             string   `json:"exchange"`
	ListedExchange       string   `json:"listed_exchange"`
	Format               string   `json:"format"`
	PriceScale           int      `json:"pricescale"`
	MinMov               float64  `json:"minmov"`
	VolumePrecision      int      `json:"volume_precision"`
	DataStatus           string   `json:"data_status"`
	HasIntraday          bool     `json:"has_intraday"`
	HasDaily             bool     `json:"has_daily"`
	HasWeeklyAndMonthly  bool     `json:"has_weekly_and_monthly"`
	SupportedResolutions []string `json:"supported_resolutions"`
	IntradayMultipliers  []string `json:"intraday_multipliers"`
	HasEmptyBars         bool     `json:"has_empty_bars"`
	VisiblePlotsSet      string   `json:"visible_plots_set"`
	CurrencyCode         string   `json:"currency_code"`
	BaseName             string   `json:"base_name"`
	Legs                 string   `json:"legs"`
	FullName             string   `json:"full_name"`
	ProName              string   `json:"pro_name"`
	Fractional           bool     `json:"fractional"`
	Sector               string   `json:"sector"`
	Industry             string   `json:"industry"`
	Delay                int      `json:"delay"`
	Volume               int      `json:"volume"`

	// The order ticket's tradable volume bounds, in LOTS. These are the fields
	// to build a volume input from. `volume_precision` above is NOT a lot value
	// and never was — it carries the .NET service's raw VolumeMin (1/10000 lot)
	// under a TradingView field name, and reading it as lots is what once
	// demanded a 100-lot minimum and blocked trading. It is preserved only for
	// wire compatibility. See docs/VOLUME-UNITS.md.
	VolumeMinLots  float64 `json:"volume_min_lots"`
	VolumeMaxLots  float64 `json:"volume_max_lots"`
	VolumeStepLots float64 `json:"volume_step_lots"`
}

// NewTVSymbolResponse returns a TVSymbolResponse pre-populated with the .NET
// constant defaults. Transforms then fill the per-symbol fields.
func NewTVSymbolResponse() TVSymbolResponse {
	return TVSymbolResponse{
		Timezone:             "Europe/Istanbul",
		Exchange:             "Opofinance",
		ListedExchange:       "Opofinance",
		Format:               "price",
		MinMov:               1,
		DataStatus:           "streaming",
		HasIntraday:          true,
		HasDaily:             true,
		HasWeeklyAndMonthly:  true,
		SupportedResolutions: []string{"1", "5", "15", "30", "60", "240", "1D", "1W", "1M"},
		IntradayMultipliers:  []string{"1"},
		HasEmptyBars:         false,
		VisiblePlotsSet:      "ohlcv",
		Fractional:           false,
		Delay:                0,
		Volume:               1000,
	}
}
