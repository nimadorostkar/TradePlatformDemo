package main

// The synthetic price source (`-source synthetic`): every instrument follows
// a deterministic multi-octave noise path, so candles for any window agree
// with each other and with the ticks that continue the path. It exists for
// offline development and tests; the default source is real market data
// (yahoo.go).

import (
	"math"
	"time"
)

// ── Deterministic price path ────────────────────────────────────────────────

// hash01 maps (seed, i) to a uniform value in [-1, 1] — splitmix64 finalizer.
func hash01(seed uint64, i int64) float64 {
	z := seed ^ (uint64(i) * 0x9E3779B97F4A7C15)
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	z ^= z >> 31
	return float64(z>>11)/float64(1<<53)*2 - 1
}

// valueNoise interpolates hashed lattice values smoothly: continuous, so a
// bar's close is the next bar's open and a tick continues the forming bar.
func valueNoise(seed uint64, x float64) float64 {
	i := math.Floor(x)
	f := x - i
	f = f * f * (3 - 2*f) // smoothstep
	a := hash01(seed, int64(i))
	b := hash01(seed, int64(i)+1)
	return a + (b-a)*f
}

// octaves: (amplitude weight, period in minutes). Long, slow swings down to
// second-level jitter, so the path looks like a market at every zoom level.
var octaves = [...][2]float64{
	{1.00, 60 * 24 * 45},
	{0.60, 60 * 24 * 7},
	{0.35, 60 * 24},
	{0.20, 60 * 4},
	{0.10, 60},
	{0.05, 10},
	{0.025, 1},
	{0.012, 0.25},
}

// price of an instrument at a unix second, in its quote currency (the bid).
func (ins *instrument) price(atSeconds float64) float64 {
	minutes := atSeconds / 60
	var s float64
	for k, o := range octaves {
		s += o[0] * valueNoise(ins.seed*7919+uint64(k)*104729, minutes/o[1])
	}
	// s is roughly in [-2.3, 2.3]; scale to the instrument's wander.
	return ins.Price * math.Exp(s/2.3*ins.Vol)
}

func (ins *instrument) tick(at time.Time) (bid, ask float64) {
	return ins.spread(ins.price(float64(at.UnixMilli()) / 1000))
}

// m1Bar is the one-minute candle starting at minuteStart (unix seconds).
func (ins *instrument) m1Bar(minuteStart int64) (o, h, l, c float64, vol int64) {
	o = ins.price(float64(minuteStart))
	c = ins.price(float64(minuteStart + 59))
	h, l = math.Max(o, c), math.Min(o, c)
	for _, sec := range [...]int64{10, 20, 30, 40, 50} {
		p := ins.price(float64(minuteStart + sec))
		h, l = math.Max(h, p), math.Min(l, p)
	}
	vol = 40 + int64(math.Abs(hash01(ins.seed+3, minuteStart/60))*400)
	return ins.round(o), ins.round(h), ins.round(l), ins.round(c), vol
}
