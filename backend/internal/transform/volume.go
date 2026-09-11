package transform

import "math"

// MT5 reports volume at two different scales, and mixing them is silent — it has
// already caused one production incident (reading VolumeMin:100 as lots made the
// order ticket demand a 100-lot minimum and blocked all trading). Every volume
// that crosses this boundary is converted here, exactly once, and the result is
// always named with an explicit `…Lots` suffix on the wire.
//
//	Field                                    Unit
//	VolumeMin / Max / Step, Volume,
//	VolumeInitial / VolumeCurrent,
//	trade-request `volume`                   1/10000 lot   (LotDivisor)
//	VolumeMinExt / MaxExt / StepExt,
//	VolumeExt, VolumeInitialExt              1/100000000 lot (LotDivisorExt)
//
// See docs/VOLUME-UNITS.md for the per-field table.
const (
	// LotDivisor converts a standard MT5 volume (1/10000 lot) to lots.
	LotDivisor = 10000.0
	// LotDivisorExt converts an extended MT5 volume (1/100000000 lot) to lots.
	LotDivisorExt = 100000000.0
	// lotPrecision is the number of decimals kept when converting to lots.
	// 1/100000000 lot needs 8; rounding there removes binary-float dust like
	// 0.009999999999999998 that would otherwise reach the order ticket.
	lotPrecision = 8
)

// Lots converts a standard MT5 volume (1/10000 lot) to lots.
func Lots(mt5Volume float64) float64 { return roundLots(mt5Volume / LotDivisor) }

// LotsExt converts an extended MT5 volume (1/100000000 lot) to lots.
func LotsExt(mt5VolumeExt float64) float64 { return roundLots(mt5VolumeExt / LotDivisorExt) }

// LotsPreferExt converts a volume pair to lots, preferring the extended field.
// MT5 populates the Ext field on brokers with extended volume precision and
// leaves it 0 otherwise, so a non-zero Ext value is always the authoritative one.
func LotsPreferExt(standard, extended float64) float64 {
	if extended != 0 {
		return LotsExt(extended)
	}
	return Lots(standard)
}

// MT5Volume converts lots back to the standard MT5 volume unit (1/10000 lot)
// used by the trade request. It rounds to the nearest whole unit: MT5 rejects
// fractional volumes, and truncating would silently shrink the order.
func MT5Volume(lots float64) int64 { return int64(math.Round(lots * LotDivisor)) }

func roundLots(v float64) float64 {
	p := math.Pow(10, lotPrecision)
	return math.Round(v*p) / p
}
