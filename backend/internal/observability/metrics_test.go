package observability

import (
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

func TestMetricsExposeImmutableBuildIdentity(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewMetrics().Handler().ServeHTTP(recorder, httptest.NewRequest("GET", "/metrics", nil))

	if recorder.Code != 200 {
		t.Fatalf("metrics status = %d, want 200", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "# HELP gateway_build_info ") {
		t.Fatal("gateway_build_info help/collector is missing")
	}
	if !strings.Contains(body, `go_version="`+runtime.Version()+`"`) {
		t.Fatalf("gateway_build_info does not identify runtime %q", runtime.Version())
	}
	if !strings.Contains(body, "gateway_build_info{") || !strings.Contains(body, "} 1") {
		t.Fatal("gateway_build_info does not expose the constant identity sample")
	}
}
