package transform

import (
	"strconv"
	"strings"
)

// MT5 states its own verdict on a trade in exactly one field: ResultRetcode.
// Everything else about a trade response — the TV status int, the presence of an
// order id — is derived and can be ambiguous. So the gateway parses the retcode
// once, here, and puts the parsed verdict on the wire alongside the raw value,
// leaving the client nothing to infer.

// TradeOutcome is the tri-state verdict of a trade submission.
type TradeOutcome string

// Trade outcomes. "unknown" is a real answer, not a failure to compute one: a
// timed-out submission has genuinely unknown state until reconciliation, and
// reporting it as a rejection would tell the trader their order does not exist
// when it may well be live.
//
// "not_submitted" is the opposite guarantee and is deliberately not folded into
// "unknown": nothing was sent to the dealer, so there is nothing to reconcile
// and a plain retry is safe. Conflating the two forces a client to treat a
// definitely-not-sent order as maybe-live.
const (
	OutcomeAccepted     TradeOutcome = "accepted"
	OutcomeRejected     TradeOutcome = "rejected"
	OutcomeUnknown      TradeOutcome = "unknown"
	OutcomeNotSubmitted TradeOutcome = "not_submitted"
)

// MT5 TRADE_RETCODE values (MT5 Manager API / MQL5 trade server return codes).
const (
	RetcodeRequote     = 10004
	RetcodeReject      = 10006
	RetcodeCancel      = 10007
	RetcodePlaced      = 10008
	RetcodeDone        = 10009
	RetcodeDonePartial = 10010
	RetcodeError       = 10011
	RetcodeTimeout     = 10012
)

// retcodeText maps a numeric MT5 retcode to its documented meaning.
var retcodeText = map[int]string{
	10004: "Requote",
	10006: "Request rejected",
	10007: "Request cancelled by trader",
	10008: "Order placed",
	10009: "Request completed",
	10010: "Request partially completed",
	10011: "Request processing error",
	10012: "Request timed out",
	10013: "Invalid request",
	10014: "Invalid volume",
	10015: "Invalid price",
	10016: "Invalid stops",
	10017: "Trading disabled",
	10018: "Market closed",
	10019: "Insufficient funds",
	10020: "Price changed",
	10021: "No quotes to process the request",
	10022: "Invalid order expiration",
	10023: "Order state changed",
	10024: "Too many requests",
	10025: "No changes in the request",
	10026: "Autotrading disabled by server",
	10027: "Autotrading disabled by client terminal",
	10028: "Request locked for processing",
	10029: "Order or position frozen",
	10030: "Unsupported fill policy",
	10031: "No connection to the trade server",
	10032: "Operation allowed for live accounts only",
	10033: "Pending-order limit reached",
	10034: "Order/position volume limit reached",
	10035: "Invalid or prohibited order type",
	10036: "Position already closed",
	10038: "Close volume exceeds the position volume",
	10039: "A close order already exists for this position",
	10040: "Open-position limit reached",
	10041: "Pending-order activation rejected, order cancelled",
	10042: "Only long positions are allowed",
	10043: "Only short positions are allowed",
	10044: "Only position closing is allowed",
	10045: "Position closing is allowed by FIFO rule only",
	10046: "Opposite positions on a single symbol are disabled",
}

// ParseRetcode extracts the numeric code from an MT5 retcode string. MT5
// returns them as "10009 Done" (code + text) or as a bare "10009"; anything
// else yields ok=false, which the caller must treat as an unknown verdict
// rather than as a success or a rejection.
func ParseRetcode(raw string) (int, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	if i := strings.IndexAny(s, " \t"); i > 0 {
		s = s[:i]
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}

// RetcodeDescription returns the documented meaning of a retcode string,
// preserving any text MT5 itself appended when the code is unrecognized.
func RetcodeDescription(raw string) string {
	code, ok := ParseRetcode(raw)
	if !ok {
		return ""
	}
	if text, known := retcodeText[code]; known {
		return text
	}
	return "Unrecognized MT5 retcode " + strconv.Itoa(code)
}

// OutcomeFromRetcode maps a retcode string to the tri-state verdict.
// Accepted covers the three codes that mean MT5 took the order: PLACED (a
// pending order now rests on the book), DONE, and DONE_PARTIAL. TIMEOUT and an
// absent/unparseable retcode are unknown; everything else is a rejection.
func OutcomeFromRetcode(raw string) TradeOutcome {
	code, ok := ParseRetcode(raw)
	if !ok {
		return OutcomeUnknown
	}
	switch code {
	case RetcodePlaced, RetcodeDone, RetcodeDonePartial:
		return OutcomeAccepted
	case RetcodeTimeout:
		return OutcomeUnknown
	default:
		return OutcomeRejected
	}
}
