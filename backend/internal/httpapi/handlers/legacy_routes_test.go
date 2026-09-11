package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// These .NET compatibility routes were duplicates, hardcoded-account
// mutations, or empty test stubs. The production gateway deliberately does not
// register them; canonical account-scoped endpoints remain available.
func TestLegacyDuplicateRoutesAreNotMounted(t *testing.T) {
	pass := func(next http.Handler) http.Handler { return next }

	a := goldenAPI()
	r := chi.NewRouter()
	r.Route("/api", func(api chi.Router) { a.Mount(api, pass, pass, pass) })

	for _, target := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/tv/TVOrder/cancelOrder/12345"},
		{http.MethodGet, "/api/tv/TVOrder/orders"},
		{http.MethodGet, "/api/tv/TVOrder/gethistory"},
		{http.MethodPost, "/api/tv/TVOrder/modifyOrder"},
		{http.MethodPost, "/api/tv/TVOrder/placeOrder"},
		{http.MethodGet, "/api/Deal/GetDataByWebSocket"},
		{http.MethodGet, "/api/Test/testMethod"},
		{http.MethodGet, "/api/Test/testMethod1"},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(target.method, target.path, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want %d", target.method, target.path, w.Code, http.StatusNotFound)
		}
	}
}
