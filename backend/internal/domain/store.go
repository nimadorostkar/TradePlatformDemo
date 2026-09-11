package domain

import "context"

// Candle is one intraday OHLCV row (table Symbolwisepricehistorydata).
type Candle struct {
	Symbol string
	Time   int64
	Open   float64
	High   float64
	Low    float64
	Close  float64
	Volume float64
}

// DailyCandle is one aggregated daily OHLC row (table Symboldailydata).
type DailyCandle struct {
	Symbol    string
	Timestamp int64
	Open      float64
	High      float64
	Low       float64
	Close     float64
}

// PriceStore is the price-history persistence the TickService and jobs use.
// Implemented by internal/store/timescale; nil in API-only deployments.
type PriceStore interface {
	// LatestTime returns the newest stored Time for symbol within [from,to], or 0.
	LatestTime(ctx context.Context, symbol string, from, to int64) (int64, error)
	// InsertCandles upserts intraday candles (ON CONFLICT (symbol,time)).
	InsertCandles(ctx context.Context, candles []Candle) error
	// DeleteOlderThan prunes intraday rows with Time < cutoff (7-day retention).
	DeleteOlderThan(ctx context.Context, cutoff int64) error
	// IntradayRange returns intraday candles for symbol within [from,to], newest
	// first (matches the .NET ReadDataFromDbOrAPI read).
	IntradayRange(ctx context.Context, symbol string, from, to int64) ([]Candle, error)
	// DailyRange returns aggregated daily candles for symbol within [from,to], asc.
	DailyRange(ctx context.Context, symbol string, from, to int64) ([]DailyCandle, error)
	// AggregateDaily rolls intraday rows in [startUnix,endUnix] into daily rows.
	AggregateDaily(ctx context.Context, startUnix, endUnix int64, symbols []string) error
	// InsertDailyCandles backfills daily rows fetched live (ON CONFLICT DO
	// NOTHING — an aggregated row always outranks a backfilled one).
	InsertDailyCandles(ctx context.Context, candles []DailyCandle) error
	// DistinctSymbols returns the symbols present in the intraday table.
	DistinctSymbols(ctx context.Context) ([]string, error)
}
