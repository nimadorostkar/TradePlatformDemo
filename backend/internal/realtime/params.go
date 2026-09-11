// Package realtime implements the /ws streaming endpoint. It reproduces the
// .NET contract exactly — the "subscription" is the connect-URL query string,
// the server pushes the serialized GlobalResponse.data every ~3s, dispatched by
// TP (1=Tick, 2=Position, 3=User, 4=Order) and methodtype (ANALYSIS §6.1) — and
// adds a shared-topic fan-out so identical subscriptions poll MT5 once and
// broadcast (docs/ARCHITECTURE.md §5.2), plus per-connection backpressure.
package realtime

import (
	"net/http"
	"net/url"
	"strings"
)

// Params is the parsed /ws query string.
type Params struct {
	Symbol     string
	ID         string
	MethodType string
	Group      string
	Login      string
	Offset     string
	Total      string
	Ticket     string
	TP         string
	Source     string
	FromTime   string
	ToTime     string
	Data       string
}

// ParseParams reads the recognized /ws query parameters.
func ParseParams(r *http.Request) Params {
	q := r.URL.Query()
	get := func(k string) string { return q.Get(k) }
	return Params{
		Symbol:     get("symbol"),
		ID:         get("id"),
		MethodType: get("methodtype"),
		Group:      get("group"),
		Login:      get("login"),
		Offset:     get("offset"),
		Total:      get("total"),
		Ticket:     get("ticket"),
		TP:         get("TP"),
		Source:     get("source"),
		FromTime:   get("fromtime"),
		ToTime:     get("totime"),
		Data:       get("data"),
	}
}

// Key canonicalizes the params into a stable subscription key. Identical
// subscriptions share one upstream poller; the key includes every field that
// affects the dispatched result.
func (p Params) Key() string {
	v := url.Values{}
	v.Set("tp", p.TP)
	v.Set("m", p.MethodType)
	v.Set("sym", p.Symbol)
	v.Set("src", p.Source)
	v.Set("grp", p.Group)
	v.Set("login", p.Login)
	v.Set("off", p.Offset)
	v.Set("tot", p.Total)
	v.Set("tic", p.Ticket)
	v.Set("id", p.ID)
	v.Set("from", p.FromTime)
	v.Set("to", p.ToTime)
	v.Set("data", p.Data)
	return v.Encode()
}

// sourceOrDefault returns the source or "mt5" when empty.
func (p Params) sourceOrDefault() string {
	if strings.TrimSpace(p.Source) == "" {
		return "mt5"
	}
	return p.Source
}
