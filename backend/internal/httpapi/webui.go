package httpapi

import (
	"encoding/json"
	"net/http"
)

// landingHTML is a browser-friendly status page served at "/". It live-checks
// the health endpoints so opening the base URL confirms the service is up.
const landingHTML = `<!doctype html><html><head><meta charset="utf-8">
<title>OpoMTSocket Gateway (Go)</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1c1e21}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#666;margin:0 0 20px}
 .row{display:flex;gap:10px;align-items:center;margin:6px 0}
 .dot{width:10px;height:10px;border-radius:50%;background:#bbb}
 .ok{background:#22c55e}.bad{background:#ef4444}
 code{background:#f2f3f5;padding:2px 6px;border-radius:4px}
 a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
 ul{padding-left:18px}
</style></head><body>
<h1>OpoMTSocket Gateway <span style="color:#888">(Go)</span></h1>
<p class="sub">MT5 → REST + WebSocket gateway. This page is a status check, not the API.</p>
<div class="row"><span id="d1" class="dot"></span><b>Liveness</b> <code>/healthz</code> <span id="s1"></span></div>
<div class="row"><span id="d2" class="dot"></span><b>Readiness</b> <code>/readyz</code> <span id="s2"></span></div>
<p>Explore the API:</p>
<ul>
 <li><a href="/swagger">/swagger</a> — interactive API console (Swagger UI)</li>
 <li><a href="/openapi.json">/openapi.json</a> — OpenAPI spec</li>
 <li>Prometheus metrics are served on the private operations listener.</li>
 <li>REST is under <code>/api/...</code> (Bearer JWT) — e.g. <code>GET /api/Test/getServerTime</code></li>
 <li>WebSocket at <code>/ws?...</code></li>
</ul>
<script>
 function chk(path,d,s){fetch(path).then(r=>{const ok=r.ok;document.getElementById(d).className='dot '+(ok?'ok':'bad');
   return r.text().then(t=>document.getElementById(s).textContent=(ok?'OK — ':'HTTP '+r.status+' — ')+t.trim());})
   .catch(e=>{document.getElementById(d).className='dot bad';document.getElementById(s).textContent='unreachable';});}
 chk('/healthz','d1','s1');chk('/readyz','d2','s2');
</script>
</body></html>`

// swaggerHTML is a self-contained API console rendered from /openapi.json.
//
// It deliberately loads nothing from a CDN. The previous version pulled Swagger
// UI's CSS and JS from unpkg.com, which made the console fail on any host
// without public egress (the production Windows VPS and every air-gapped or
// proxy-restricted deployment) and ran unpinned third-party script on the
// gateway's own origin, where a browser would happily let it read the bearer
// token typed into it. Everything below is served by this binary.
const swaggerHTML = `<!doctype html><html><head><meta charset="utf-8">
<title>OpoMTSocket API</title>
<style>
 body{font:14px/1.55 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 16px;color:#1c1e21}
 h1{font-size:21px;margin:0 0 2px} .sub{color:#666;margin:0 0 18px}
 .auth{display:flex;gap:8px;align-items:center;margin:0 0 20px;flex-wrap:wrap}
 .auth input{flex:1;min-width:260px;font:12px ui-monospace,monospace;padding:7px 9px;border:1px solid #d0d3d8;border-radius:6px}
 h2{font-size:15px;margin:26px 0 8px;padding-bottom:5px;border-bottom:1px solid #e6e8eb;color:#374151}
 .op{border:1px solid #e6e8eb;border-radius:6px;margin:6px 0;overflow:hidden}
 .op>summary{cursor:pointer;padding:8px 11px;display:flex;gap:9px;align-items:center;list-style:none}
 .op>summary::-webkit-details-marker{display:none}
 .m{font:600 11px ui-monospace,monospace;padding:2px 7px;border-radius:4px;color:#fff;min-width:52px;text-align:center}
 .GET{background:#2563eb}.POST{background:#16a34a}.DELETE{background:#dc2626}.PUT,.PATCH{background:#d97706}
 .p{font:12px ui-monospace,monospace}
 .sum{color:#6b7280;font-size:12px;margin-left:auto;text-align:right}
 .lock{font-size:11px;color:#92400e;background:#fef3c7;border-radius:4px;padding:1px 6px}
 .body{padding:10px 12px;border-top:1px solid #eef0f2;background:#fafbfc}
 .body label{display:block;font-size:11px;color:#6b7280;margin:6px 0 3px}
 .body input,.body textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,monospace;padding:6px 8px;border:1px solid #d0d3d8;border-radius:5px}
 button{font:13px system-ui;padding:6px 13px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
 button:hover{background:#1d4ed8}
 pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;overflow:auto;max-height:340px;font-size:12px;margin:9px 0 0}
 .err{color:#b91c1c}
</style></head><body>
<h1>OpoMTSocket API</h1>
<p class="sub">Rendered from <a href="/openapi.json">/openapi.json</a>. Served entirely by this gateway — no external assets.</p>
<div class="auth"><b>Bearer token</b><input id="tok" placeholder="paste the JWT from /api/Authentication/login" autocomplete="off"></div>
<div id="out">Loading&hellip;</div>
<script>
(function(){
 var out=document.getElementById('out');
 fetch('/openapi.json').then(function(r){return r.json()}).then(render).catch(function(e){
   out.innerHTML='<p class="err">Could not load /openapi.json: '+String(e)+'</p>';});

 function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}

 function render(spec){
  out.textContent='';
  var groups={},paths=spec.paths||{};
  Object.keys(paths).sort().forEach(function(p){
   Object.keys(paths[p]).forEach(function(m){
    var op=paths[p][m],tag=(op.tags&&op.tags[0])||p.split('/')[2]||'general';
    (groups[tag]=groups[tag]||[]).push({method:m.toUpperCase(),path:p,op:op});
   });
  });
  Object.keys(groups).sort().forEach(function(tag){
   out.appendChild(el('h2',null,tag));
   groups[tag].forEach(function(e){out.appendChild(operation(e))});
  });
 }

 function operation(e){
  var d=el('details','op'),s=el('summary');
  s.appendChild(el('span','m '+e.method,e.method));
  s.appendChild(el('span','p',e.path));
  if(e.op.security&&e.op.security.length){
   var names={};e.op.security.forEach(function(r){Object.keys(r).forEach(function(k){names[k]=1})});
   s.appendChild(el('span','lock',Object.keys(names).join(' + ')));
  }
  s.appendChild(el('span','sum',e.op.summary||''));
  d.appendChild(s);
  d.appendChild(form(e));
  return d;
 }

 function form(e){
  var b=el('div','body'),params=(e.op.parameters||[]).filter(function(p){return p.in==='query'||p.in==='path'}),inputs={};
  params.forEach(function(p){
   b.appendChild(el('label',null,p.name+(p.required?' *':'')+'  ('+p.in+')'));
   var i=document.createElement('input');i.placeholder=p.description||p.name;inputs[p.name]=i;b.appendChild(i);
  });
  var bodyEl=null;
  if(e.op.requestBody){
   b.appendChild(el('label',null,'request body (JSON)'));
   bodyEl=document.createElement('textarea');bodyEl.rows=4;bodyEl.placeholder='{ }';b.appendChild(bodyEl);
  }
  var btn=el('button',null,'Send'),pre=el('pre');pre.style.display='none';
  b.appendChild(el('div',null,'')).appendChild(btn);
  b.appendChild(pre);
  btn.addEventListener('click',function(){send(e,params,inputs,bodyEl,pre)});
  return b;
 }

 function send(e,params,inputs,bodyEl,pre){
  var path=e.path,q=[];
  params.forEach(function(p){
   var v=inputs[p.name].value;
   if(v==='')return;
   if(p.in==='path')path=path.replace('{'+p.name+'}',encodeURIComponent(v));
   else q.push(encodeURIComponent(p.name)+'='+encodeURIComponent(v));
  });
  var url=path+(q.length?'?'+q.join('&'):''),opts={method:e.method,headers:{}},tok=document.getElementById('tok').value.trim();
  if(tok)opts.headers['Authorization']='Bearer '+tok;
  if(bodyEl&&bodyEl.value.trim()){opts.headers['Content-Type']='application/json';opts.body=bodyEl.value}
  pre.style.display='';pre.textContent='…';
  fetch(url,opts).then(function(r){
   return r.text().then(function(t){
    var pretty=t;try{pretty=JSON.stringify(JSON.parse(t),null,2)}catch(_){}
    pre.textContent='HTTP '+r.status+' '+r.statusText+'\n\n'+pretty;
   });
  }).catch(function(err){pre.textContent='Request failed: '+String(err)});
 }
})();
</script>
</body></html>`

func landingHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(landingHTML))
}

func swaggerHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(swaggerHTML))
}

func openapiHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(openAPISpec())
}

// openAPISpec builds a compact OpenAPI 3.0 document covering the REST surface.
// It is generated from a route table so Swagger UI's "Try it out" works against
// the live server.
func openAPISpec() []byte {
	type ep struct {
		method, path, summary string
		secured               bool
		params                []string // query param names
	}
	bearer := []map[string][]string{{"bearerAuth": {}}}
	managerBearer := []map[string][]string{{"bearerAuth": {}, "managerKey": {}}}
	managerRoutes := map[string]struct{}{
		"get /api/Order/get": {}, "delete /api/Order/delete": {}, "post /api/Order/update_order": {},
		"get /api/Order/cancel": {}, "get /api/Order/list": {}, "get /api/Order/getbackup": {},
		"post /api/Order/restore": {}, "get /api/Order/reopen": {},
		"post /api/Position/update_position": {}, "delete /api/Position/delete": {},
		"get /api/Position/backup_list": {}, "get /api/Position/backup_get": {},
		"post /api/Position/restore": {}, "get /api/Position/checkPosition": {}, "get /api/Position/fixPosition": {},
		"get /api/Deal/get": {}, "post /api/Deal/update_deal": {}, "delete /api/Deal/delete": {},
		"get /api/Deal/backup_list": {}, "get /api/Deal/backup_get": {}, "post /api/Deal/restore_deal": {},
		"get /api/History/get": {}, "delete /api/History/delete": {}, "post /api/History/update_history": {},
		"get /api/Trade/balance": {}, "get /api/Trade/get_request_result": {},
	}
	eps := []ep{
		{"post", "/api/Authentication/login", "Login (CRMToken for production)", false, nil},
		{"post", "/api/Authentication/crmlogin", "CRM login", false, nil},
		{"post", "/api/Authentication/accounts", "Tradable accounts + symbol suffixes", false, nil},
		{"get", "/api/Capabilities", "Which features this gateway serves", false, nil},
		// Order
		{"get", "/api/Order/get", "Get order", true, []string{"ticket"}},
		{"get", "/api/Order/get_total", "Order count", true, []string{"login"}},
		{"get", "/api/Order/get_page", "Order page", true, []string{"login", "offset", "total", "source"}},
		{"get", "/api/Order/get_batch", "Order batch", true, []string{"login", "group", "ticket", "symbol"}},
		{"delete", "/api/Order/delete", "Delete order", true, []string{"ticket"}},
		{"post", "/api/Order/update_order", "Update order", true, nil},
		{"get", "/api/Order/cancel", "Cancel order", true, []string{"ticket"}},
		{"get", "/api/Order/list", "Backup list", true, []string{"from", "to", "server"}},
		{"get", "/api/Order/getbackup", "Orders from backup", true, []string{"backup", "login", "ticket", "from", "to", "server"}},
		{"post", "/api/Order/restore", "Restore order", true, nil},
		{"get", "/api/Order/reopen", "Reopen order", true, []string{"ticket"}},
		// Position
		{"get", "/api/Position/get", "Get position", true, []string{"login", "symbol", "source"}},
		{"get", "/api/Position/get_total", "Position count", true, []string{"login"}},
		{"get", "/api/Position/get_page", "Position page", true, []string{"login", "offset", "total", "source"}},
		{"get", "/api/Position/get_batch", "Position batch", true, []string{"login", "group", "ticket", "symbol"}},
		{"post", "/api/Position/update_position", "Update position", true, nil},
		{"delete", "/api/Position/delete", "Delete position", true, []string{"ticket"}},
		{"get", "/api/Position/backup_list", "Position backup list", true, []string{"from", "end", "server"}},
		{"get", "/api/Position/backup_get", "Position from backup", true, []string{"backup", "login", "from", "end", "server"}},
		{"post", "/api/Position/restore", "Restore position", true, nil},
		{"get", "/api/Position/checkPosition", "Check position", true, []string{"login"}},
		{"get", "/api/Position/fixPosition", "Fix position", true, []string{"login"}},
		// Deal
		{"get", "/api/Deal/get", "Get deal", true, []string{"ticket"}},
		{"get", "/api/Deal/get_total", "Deal count", true, []string{"login", "from", "to"}},
		{"get", "/api/Deal/get_page", "Deal page", true, []string{"login", "from", "to", "offset", "index"}},
		{"get", "/api/Deal/get_batch", "Deal batch", true, []string{"login", "group", "ticket", "from", "to", "symbol"}},
		{"post", "/api/Deal/update_deal", "Update deal", true, nil},
		{"delete", "/api/Deal/delete", "Delete deal", true, []string{"ticket"}},
		{"get", "/api/Deal/backup_list", "Deal backup list", true, []string{"from", "to", "server"}},
		{"get", "/api/Deal/backup_get", "Deal from backup", true, []string{"backup", "login", "from", "to", "server"}},
		{"post", "/api/Deal/restore_deal", "Restore deal", true, nil},
		{"get", "/api/Deal/since", "Executions since a cursor (per-fill feed)", true, []string{"login", "after", "limit"}},
		// History
		{"get", "/api/History/get", "Get closed order", true, []string{"ticket"}},
		{"get", "/api/History/get_total", "Closed order count", true, []string{"login", "from", "to"}},
		{"get", "/api/History/get_page", "Closed order page", true, []string{"login", "from", "to", "offset", "total", "source"}},
		{"get", "/api/History/get_batch", "Closed order batch", true, []string{"login", "groups", "tickets", "from", "to", "symbol"}},
		{"delete", "/api/History/delete", "Delete closed order", true, []string{"ticket"}},
		{"post", "/api/History/update_history", "Update history", true, nil},
		// Symbol
		{"get", "/api/Symbol/getlist", "Symbol list", true, nil},
		{"get", "/api/Symbol/getsymbolsbyname", "Symbol by name", true, []string{"symbol", "source"}},
		{"get", "/api/Symbol/getsymbolsbymask", "Symbols by mask", true, []string{"mask", "source"}},
		{"get", "/api/Symbol/getsymbolsbygroup", "Symbols by group", true, []string{"symbol", "group", "source"}},
		{"get", "/api/Symbol/getGroup", "Get group", true, []string{"group"}},
		// Tick
		{"get", "/api/Tick/last", "Last quote", true, []string{"symbol", "Id", "source"}},
		{"get", "/api/Tick/last_group", "Last quote (group)", true, []string{"symbol", "group", "Id"}},
		{"get", "/api/Tick/stat", "Tick stat", true, []string{"symbol", "Id"}},
		{"get", "/api/Tick/history", "Tick history", true, []string{"symbol", "from", "to", "data"}},
		{"get", "/api/Tick/get", "Chart M1/intraday", true, []string{"symbol", "from", "to", "data", "resolution"}},
		{"get", "/api/Tick/getHistoryby1Dresolution", "Chart 1D/1W/1M", true, []string{"symbol", "from", "to", "resolution"}},
		{"get", "/api/Tick/get_marketdepth", "Market depth", true, []string{"symbol"}},
		// Trade
		{"get", "/api/Trade/balance", "Balance op", true, []string{"login", "type", "balance", "comment"}},
		{"get", "/api/Trade/calc_buy_rate", "Calc buy rate", true, []string{"basecurrency", "currency", "group", "symbol", "price"}},
		{"get", "/api/Trade/calc_sell_rate", "Calc sell rate", true, []string{"basecurrency", "currency", "group", "symbol", "price"}},
		{"get", "/api/Trade/check_margin", "Check margin", true, []string{"login", "symbol", "type", "volume", "price"}},
		{"get", "/api/Trade/calc_profit", "Calc profit", true, []string{"group", "symbol", "type", "volume", "price_open", "price_close"}},
		{"post", "/api/Trade/send_request", "Send trade request", true, nil},
		{"get", "/api/Trade/get_request_result", "Get request result", true, []string{"id"}},
		// Alerts (server-side price alerts)
		{"get", "/api/Alert/list", "List price alerts", true, []string{"login"}},
		{"post", "/api/Alert/create", "Create a price alert", true, nil},
		{"delete", "/api/Alert/delete", "Delete a price alert", true, []string{"id", "login"}},
		// Workspace (layout persistence)
		{"get", "/api/Workspace/get", "Get the stored workspace", true, []string{"login"}},
		{"post", "/api/Workspace/save", "Save the workspace", true, nil},
		// News / calendar (provider proxies)
		{"get", "/api/News/list", "News feed", true, []string{"symbol", "from", "to", "limit", "lang"}},
		{"get", "/api/Calendar/list", "Economic calendar", true, []string{"from", "to", "country", "importance"}},
		// User
		{"get", "/api/User/get", "Get user", true, []string{"login", "source"}},
		{"get", "/api/User/get_trade_state", "Trade state", true, []string{"login", "source"}},
		// Test
		{"get", "/api/Test/getServerTime", "Server time", true, nil},
		{"get", "/api/Test/getUTCTime", "UTC time", true, nil},
	}

	paths := map[string]any{}
	for _, e := range eps {
		params := []map[string]any{}
		for _, p := range e.params {
			params = append(params, map[string]any{
				"name": p, "in": "query", "required": false,
				"schema": map[string]string{"type": "string"},
			})
		}
		op := map[string]any{
			"summary":   e.summary,
			"responses": map[string]any{"200": map[string]any{"description": "OK"}},
		}
		if len(params) > 0 {
			op["parameters"] = params
		}
		if e.secured {
			op["security"] = bearer
		}
		if _, managerOnly := managerRoutes[e.method+" "+e.path]; managerOnly {
			op["security"] = managerBearer
		}
		if e.method == "post" {
			op["requestBody"] = map[string]any{
				"content": map[string]any{"application/json": map[string]any{
					"schema": map[string]string{"type": "object"}}},
			}
		}
		entry, ok := paths[e.path].(map[string]any)
		if !ok {
			entry = map[string]any{}
			paths[e.path] = entry
		}
		entry[e.method] = op
	}

	spec := map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title": "OpoMTSocket Gateway (Go)", "version": "1.0.0",
			"description": "MT5 → REST + WebSocket gateway. Most endpoints require a Bearer JWT (obtain via /api/Authentication/login).",
		},
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"bearerAuth": map[string]string{"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
				"managerKey": map[string]string{"type": "apiKey", "in": "header", "name": "X-Manager-Key"},
			},
		},
		"paths": paths,
	}
	b, _ := json.Marshal(spec)
	return b
}
