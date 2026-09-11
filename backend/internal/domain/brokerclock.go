package domain

import "context"

// BrokerClock reports broker_clock − UTC in seconds.
//
// MT5 stamps every account artifact — deals, closed orders, positions, order
// setup times — on the trade server's own clock (this broker runs UTC+3), and
// it interprets every from/to window it is asked for on that same clock. The
// public API of this gateway speaks UTC. A service holding a BrokerClock adds
// the offset to windows on the way IN to MT5 and subtracts it from timestamps
// on the way OUT, which is the single place the two time bases are allowed to
// meet (the chart path in TickService pioneered this contract).
//
// A nil clock means "no conversion" and reproduces the legacy pass-through —
// unit tests and partial deployments rely on that.
type BrokerClock func(ctx context.Context) int64

// brokerOffset resolves a possibly-nil clock.
func brokerOffset(ctx context.Context, clock BrokerClock) int64 {
	if clock == nil {
		return 0
	}
	return clock(ctx)
}
