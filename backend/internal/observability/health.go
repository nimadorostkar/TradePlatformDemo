package observability

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
)

// Health tracks liveness and readiness. Liveness is true once the process is up;
// readiness flips true only after dependencies (MT5 session, DB, bus) report ready.
// Subsystems call SetReady(false) when a critical dependency degrades so that
// orchestrators (k8s) stop routing traffic to this pod.
type Health struct {
	ready atomic.Bool
}

// NewHealth returns a Health that is live but not yet ready.
func NewHealth() *Health { return &Health{} }

// SetReady updates the readiness state.
func (h *Health) SetReady(ready bool) { h.ready.Store(ready) }

// Ready reports the current readiness state.
func (h *Health) Ready() bool { return h.ready.Load() }

// LivenessHandler returns 200 whenever the process is running.
func (h *Health) LivenessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "alive"})
	}
}

// ReadinessHandler returns 200 when ready, 503 otherwise.
func (h *Health) ReadinessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if h.Ready() {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
			return
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
