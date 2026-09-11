package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLandingAndSwagger(t *testing.T) {
	w := httptest.NewRecorder()
	landingHandler(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "LegacyMTSocket") {
		t.Errorf("landing: code=%d", w.Code)
	}

	w = httptest.NewRecorder()
	swaggerHandler(w, httptest.NewRequest("GET", "/swagger", nil))
	body := w.Body.String()
	if w.Code != 200 || !strings.Contains(body, "/openapi.json") {
		t.Errorf("swagger: code=%d", w.Code)
	}
}

// The API console must stay self-contained. Loading it from a CDN broke every
// deployment without public egress and ran third-party script on the same
// origin as the bearer token the console accepts.
func TestServedPagesReferenceNoExternalAssets(t *testing.T) {
	for name, h := range map[string]func(w http.ResponseWriter, r *http.Request){
		"landing": landingHandler,
		"swagger": swaggerHandler,
	} {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("GET", "/", nil))
		for _, host := range []string{"unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com"} {
			if strings.Contains(w.Body.String(), host) {
				t.Errorf("%s page references external host %q", name, host)
			}
		}
		if strings.Contains(w.Body.String(), "src=\"http") || strings.Contains(w.Body.String(), "href=\"http") {
			t.Errorf("%s page loads an absolute-URL asset", name)
		}
	}
}

func TestOpenAPISpec(t *testing.T) {
	var spec map[string]any
	if err := json.Unmarshal(openAPISpec(), &spec); err != nil {
		t.Fatalf("openapi not valid json: %v", err)
	}
	paths, ok := spec["paths"].(map[string]any)
	if !ok || len(paths) < 50 {
		t.Fatalf("expected >=50 paths, got %d", len(paths))
	}
	// A ticket-only manager endpoint requires both credentials in the same
	// security alternative (an array entry means AND in OpenAPI).
	order := paths["/api/Order/get"].(map[string]any)["get"].(map[string]any)
	security, ok := order["security"].([]any)
	if !ok || len(security) != 1 {
		t.Fatalf("unexpected security on /api/Order/get: %#v", order["security"])
	}
	requirement := security[0].(map[string]any)
	if _, has := requirement["bearerAuth"]; !has {
		t.Error("expected bearerAuth on /api/Order/get")
	}
	if _, has := requirement["managerKey"]; !has {
		t.Error("expected managerKey on /api/Order/get")
	}
}
