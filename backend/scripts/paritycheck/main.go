// Command paritycheck replays identical requests against the legacy .NET
// OpoMTSocket and the Go gateway and compares the responses (Phase-1
// validation, item 2).
//
// JSON comparison is structural-first: missing/extra keys and type mismatches
// are hard failures (exit 1); value-only differences are reported as warnings,
// since live market data (prices, timestamps) legitimately differs between two
// sequential calls. Strings that themselves contain JSON (the RAW_STRING
// passthrough endpoints) are parsed and compared as JSON.
//
// Usage:
//
//	go run ./scripts/paritycheck \
//	  -dotnet http://<dotnet-host>:5063 -go http://localhost:5063 \
//	  -token "$JWT" -login 1010 -symbol EURUSD
//
// The token must be valid on BOTH services (shared JWT secret). Only
// read-only endpoints are exercised; -send-trade opts into POSTing a real
// /api/Trade/send_request (places an actual order — staging only!).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type target struct {
	name string
	base string
}

type check struct {
	name   string
	method string
	path   string // includes query; %LOGIN%, %SYMBOL%, %GROUP% substituted
	body   string
}

func main() {
	dotnetBase := flag.String("dotnet", "", "base URL of the legacy .NET service (required)")
	goBase := flag.String("go", "", "base URL of the Go service (required)")
	token := flag.String("token", "", "JWT valid on both services")
	login := flag.String("login", "1010", "account login used in queries")
	symbol := flag.String("symbol", "EURUSD", "symbol used in queries")
	group := flag.String("group", "", "symbol group (optional checks skipped when empty)")
	doWS := flag.Bool("ws", true, "compare WebSocket tick + position frames")
	sendTrade := flag.Bool("send-trade", false, "DANGER: POST a real trade via /api/Trade/send_request (staging only)")
	timeout := flag.Duration("timeout", 15*time.Second, "per-request timeout")
	flag.Parse()

	if *dotnetBase == "" || *goBase == "" {
		fmt.Fprintln(os.Stderr, "both -dotnet and -go are required")
		flag.Usage()
		os.Exit(2)
	}

	targets := [2]target{{"dotnet", strings.TrimRight(*dotnetBase, "/")}, {"go", strings.TrimRight(*goBase, "/")}}

	from := time.Now().Add(-24 * time.Hour).Unix()
	to := time.Now().Unix()
	checks := []check{
		{"test/getServerTime", "GET", "/api/Test/getServerTime", ""},
		{"position/get", "GET", "/api/Position/get?login=%LOGIN%&symbol=%SYMBOL%", ""},
		{"position/get(tv)", "GET", "/api/Position/get?login=%LOGIN%&symbol=%SYMBOL%&source=tv", ""},
		{"position/get_total", "GET", "/api/Position/get_total?login=%LOGIN%", ""},
		{"position/get_page", "GET", "/api/Position/get_page?login=%LOGIN%&offset=0&total=10", ""},
		{"position/get_page(tv)", "GET", "/api/Position/get_page?login=%LOGIN%&offset=0&total=10&source=tv", ""},
		{"order/get_total", "GET", "/api/Order/get_total?login=%LOGIN%", ""},
		{"order/get_page(tv)", "GET", "/api/Order/get_page?login=%LOGIN%&offset=0&total=10&source=tv", ""},
		{"history/get_page(tv)", "GET", fmt.Sprintf("/api/History/get_page?login=%%LOGIN%%&from=%d&to=%d&offset=0&total=10&source=tv", from, to), ""},
		{"symbol/getlist", "GET", "/api/Symbol/getlist", ""},
		{"symbol/byname(tv)", "GET", "/api/Symbol/getsymbolsbyname?symbol=%SYMBOL%&source=tv", ""},
		{"tick/last", "GET", "/api/Tick/last?symbol=%SYMBOL%&Id=0", ""},
		{"tick/last(tv)", "GET", "/api/Tick/last?symbol=%SYMBOL%&Id=0&source=tv", ""},
		{"tick/get(chart)", "GET", fmt.Sprintf("/api/Tick/get?symbol=%%SYMBOL%%&from=%d&to=%d&data=M1", from, to), ""},
		{"trade/check_margin", "GET", "/api/Trade/check_margin?login=%LOGIN%&symbol=%SYMBOL%&type=0&volume=10000&price=0", ""},
		{"trade/calc_profit", "GET", "/api/Trade/calc_profit?group=%GROUP%&symbol=%SYMBOL%&type=0&volume=10000&price_open=1.1&price_close=1.2", ""},
		{"user/get(tv)", "GET", "/api/User/get?login=%LOGIN%&source=tv", ""},
		{"user/get_trade_state(tv)", "GET", "/api/User/get_trade_state?login=%LOGIN%&source=tv", ""},
		{"tv/orders", "GET", "/api/tv/TVOrder/orders", ""},
		{"tv/gethistory", "GET", "/api/tv/TVOrder/gethistory", ""},
	}
	if *sendTrade {
		checks = append(checks, check{"trade/send_request", "POST", "/api/Trade/send_request",
			fmt.Sprintf(`{"Action":"200","Login":%s,"Symbol":"%s","Volume":10000,"TypeFill":0,"Type":0,"PriceOrder":0,"Digits":5}`, *login, *symbol)})
	}

	sub := strings.NewReplacer("%LOGIN%", *login, "%SYMBOL%", *symbol, "%GROUP%", *group)
	client := &http.Client{Timeout: *timeout}

	var structural, valueOnly, failed int
	for _, ch := range checks {
		if strings.Contains(ch.path, "%GROUP%") && *group == "" {
			fmt.Printf("SKIP  %-28s (needs -group)\n", ch.name)
			continue
		}
		path := sub.Replace(ch.path)
		var bodies [2][]byte
		var codes [2]int
		reqErr := false
		for i, t := range targets {
			b, code, err := doReq(client, ch.method, t.base+path, ch.body, *token)
			if err != nil {
				fmt.Printf("ERROR %-28s %s: %v\n", ch.name, t.name, err)
				reqErr = true
				break
			}
			bodies[i], codes[i] = b, code
		}
		if reqErr {
			failed++
			continue
		}
		if codes[0] != codes[1] {
			fmt.Printf("DIFF  %-28s status: dotnet=%d go=%d\n", ch.name, codes[0], codes[1])
			structural++
			continue
		}
		diffs := compareJSON(bodies[0], bodies[1])
		report(ch.name, diffs, &structural, &valueOnly)
	}

	if *doWS {
		wsChecks := []struct{ name, query string }{
			{"ws/tick(tv)", "TP=1&methodtype=GetQuotes&symbol=" + *symbol + "&source=tv"},
			{"ws/position", "TP=2&methodtype=GetPagebyPagePositionWs&login=" + *login + "&offset=0&total=10"},
		}
		for _, wc := range wsChecks {
			var frames [2][]byte
			wsErr := false
			for i, t := range targets {
				f, err := wsFirstFrame(t.base, wc.query, *token, *timeout)
				if err != nil {
					fmt.Printf("ERROR %-28s %s: %v\n", wc.name, t.name, err)
					wsErr = true
					break
				}
				frames[i] = f
			}
			if wsErr {
				failed++
				continue
			}
			diffs := compareJSON(frames[0], frames[1])
			report(wc.name, diffs, &structural, &valueOnly)
		}
	}

	fmt.Printf("\n== parity: %d structural diff(s), %d value-only diff(s), %d request failure(s) ==\n",
		structural, valueOnly, failed)
	fmt.Println("value-only diffs on live fields (prices, times, ids) are expected; review each once.")
	if structural > 0 || failed > 0 {
		os.Exit(1)
	}
}

func doReq(c *http.Client, method, url, body, token string) ([]byte, int, error) {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return nil, 0, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return b, resp.StatusCode, err
}

func wsFirstFrame(base, query, token string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	url := strings.Replace(base, "http", "ws", 1) + "/ws?" + query
	if token != "" {
		url += "&access_token=" + token
	}
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	defer conn.CloseNow()
	_, data, err := conn.Read(ctx)
	return data, err
}

func report(name string, diffs []diff, structural, valueOnly *int) {
	hard := make([]diff, 0)
	soft := make([]diff, 0)
	for _, d := range diffs {
		if d.structural {
			hard = append(hard, d)
		} else {
			soft = append(soft, d)
		}
	}
	switch {
	case len(hard) > 0:
		*structural++
		fmt.Printf("DIFF  %-28s %d structural, %d value\n", name, len(hard), len(soft))
		for _, d := range hard {
			fmt.Printf("        STRUCT %s: %s\n", d.path, d.msg)
		}
		for _, d := range soft {
			fmt.Printf("        value  %s: %s\n", d.path, d.msg)
		}
	case len(soft) > 0:
		*valueOnly++
		fmt.Printf("VALUE %-28s %d value-only diff(s)\n", name, len(soft))
		for _, d := range soft {
			fmt.Printf("        value  %s: %s\n", d.path, d.msg)
		}
	default:
		fmt.Printf("PASS  %-28s identical\n", name)
	}
}

type diff struct {
	path       string
	msg        string
	structural bool
}

// compareJSON deep-compares two JSON bodies. Non-JSON bodies fall back to a
// byte comparison. String values containing JSON are parsed and compared
// structurally (RAW_STRING passthrough endpoints).
func compareJSON(a, b []byte) []diff {
	var av, bv any
	errA := json.Unmarshal(a, &av)
	errB := json.Unmarshal(b, &bv)
	if errA != nil || errB != nil {
		if string(a) == string(b) {
			return nil
		}
		return []diff{{"$", fmt.Sprintf("non-JSON bodies differ: %q vs %q", trunc(a), trunc(b)), true}}
	}
	var out []diff
	walk("$", av, bv, &out)
	return out
}

func walk(path string, a, b any, out *[]diff) {
	// Nested-JSON strings: compare parsed forms.
	if as, ok := a.(string); ok {
		if bs, ok2 := b.(string); ok2 {
			var an, bn any
			if json.Unmarshal([]byte(as), &an) == nil && json.Unmarshal([]byte(bs), &bn) == nil &&
				(strings.HasPrefix(strings.TrimSpace(as), "{") || strings.HasPrefix(strings.TrimSpace(as), "[")) {
				walk(path+"<json>", an, bn, out)
				return
			}
		}
	}
	switch at := a.(type) {
	case map[string]any:
		bt, ok := b.(map[string]any)
		if !ok {
			*out = append(*out, diff{path, fmt.Sprintf("type: dotnet=object go=%T", b), true})
			return
		}
		keys := map[string]bool{}
		for k := range at {
			keys[k] = true
		}
		for k := range bt {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			av, aok := at[k]
			bv, bok := bt[k]
			switch {
			case !aok:
				*out = append(*out, diff{path + "." + k, "extra field in go response", true})
			case !bok:
				*out = append(*out, diff{path + "." + k, "missing field in go response", true})
			default:
				walk(path+"."+k, av, bv, out)
			}
		}
	case []any:
		bt, ok := b.([]any)
		if !ok {
			*out = append(*out, diff{path, fmt.Sprintf("type: dotnet=array go=%T", b), true})
			return
		}
		if len(at) != len(bt) {
			// Live data: differing element counts are a value diff, but compare
			// the overlapping prefix for structure.
			*out = append(*out, diff{path, fmt.Sprintf("array length: dotnet=%d go=%d", len(at), len(bt)), false})
		}
		n := min(len(at), len(bt))
		for i := 0; i < n; i++ {
			walk(fmt.Sprintf("%s[%d]", path, i), at[i], bt[i], out)
		}
	default:
		if fmt.Sprintf("%T", a) != fmt.Sprintf("%T", b) {
			*out = append(*out, diff{path, fmt.Sprintf("type: dotnet=%T go=%T", a, b), true})
			return
		}
		if a != b {
			*out = append(*out, diff{path, fmt.Sprintf("dotnet=%v go=%v", a, b), false})
		}
	}
}

func trunc(b []byte) string {
	s := string(b)
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}
