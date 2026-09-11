# Volume units

MT5 reports volume at **two different scales**, and mixing them is silent. This
has already caused one production incident: `VolumeMin: 100` was read as lots,
so the order ticket demanded a 100-lot minimum and blocked all trading.

There is no way to tell the scales apart by looking at a number. This page
states the unit of every volume field that crosses the gateway.

## The two scales

| Scale | Divisor to lots | Used by |
|---|---|---|
| **Standard** | `÷ 10 000` | every non-`Ext` MT5 volume field |
| **Extended** | `÷ 100 000 000` | every `…Ext` MT5 volume field |

MT5 populates the `Ext` fields only on brokers with extended volume precision
and leaves them `0` otherwise, so **a non-zero `Ext` value is always the
authoritative one**. That rule is implemented once, in
[`transform.LotsPreferExt`](../internal/transform/volume.go), and every mapping
goes through it.

## Upstream (MT5 → gateway)

| MT5 field | Unit |
|---|---|
| `VolumeMin`, `VolumeMax`, `VolumeStep` | 1/10000 lot |
| `VolumeMinExt`, `VolumeMaxExt`, `VolumeStepExt` | 1/100000000 lot |
| `Volume` (position, deal, trade request) | 1/10000 lot |
| `VolumeExt` (position, deal) | 1/100000000 lot |
| `VolumeInitial`, `VolumeCurrent` (order) | 1/10000 lot |
| `VolumeInitialExt`, `VolumeCurrentExt` (order) | 1/100000000 lot |
| `ResultVolume` (trade result) | 1/10000 lot |
| Book entry `Volume` / `VolumeExt` | 1/10000 lot / 1/100000000 lot |

## Downstream (gateway → client)

**Every field whose name ends in `Lots`, and every volume in the market-depth
ladder, is in lots.** Everything else preserves the raw MT5 unit for wire
compatibility with the .NET service.

| Endpoint / shape | Field | Unit |
|---|---|---|
| Order (`TVOrderHistory`) | `qty`, `filledQty` | 1/10000 lot |
| Order (`TVOrderHistory`) | **`qtyLots`, `filledQtyLots`** | **lots** |
| Position (`TVPositionResponse`) | `qty` | 1/10000 lot |
| Position (`TVPositionResponse`) | **`qtyLots`** | **lots** |
| Trade result (`PlacedOrder`) | `qty`, `filledQty` | 1/10000 lot |
| Trade result (`PlacedOrder`) | **`qtyLots`, `filledQtyLots`** | **lots** |
| Symbol (`TVSymbolResponse`) | **`volume_min_lots`, `volume_max_lots`, `volume_step_lots`** | **lots** |
| Market depth (`MarketDepth`) | `bids[].volume`, `asks[].volume` | **lots** (and the payload says so: `"volumeUnit":"lots"`) |
| Execution (`TVExecution`) | **`qty`** | **lots** |
| Execution (`TVExecution`) | `qtyMt5` | 1/10000 lot |
| Trade request `Volume` (client → gateway → MT5) | 1/10000 lot |

### Build the order ticket from `volume_min_lots` / `volume_max_lots` / `volume_step_lots`

⚠️ **`volume_precision` on the symbol shape is not a lot value and never was.**
It carries the .NET service's raw `VolumeMin` (1/10000 lot) under a TradingView
field name. Reading it as lots is exactly what caused the outage. It is
preserved only for wire compatibility — use the `_lots` fields instead.

The same caution applies to `pricescale` on the `getsymbolsbygroup` block, which
the .NET service filled from `VolumeMinExt`.

## Converting

```go
transform.Lots(10000)                 // → 1        (standard → lots)
transform.LotsExt(100000000)          // → 1        (extended → lots)
transform.LotsPreferExt(10000, 0)     // → 1        (Ext unset, use standard)
transform.LotsPreferExt(10000, 5e6)   // → 0.05     (Ext set, it wins)
transform.MT5Volume(0.03)             // → 300      (lots → standard, rounded)
```

`MT5Volume` **rounds** rather than truncates: `0.03 × 10000` is `299.999…` in
binary floating point, and truncating would silently shrink the order to 0.0299
lots — which MT5 then rejects for an invalid volume step.
