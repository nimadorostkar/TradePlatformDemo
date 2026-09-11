// Package response defines the universal API envelope and write helpers.
//
// PARITY-CRITICAL: the JSON shape, field names, field order, and the
// success→200 / failure→400 status convention must match the .NET service
// exactly (see docs/ANALYSIS.md §11). Field order below is intentional:
// data, errorMessage, message, success — matching Newtonsoft's output.
package response

import (
	"encoding/json"
	"net/http"
)

// GlobalResponse is the envelope returned by every endpoint.
//
//	{ "data": <any>, "errorMessage": null, "message": null, "success": true }
//
// ErrorMessage and Message are pointers so they serialize as JSON null (not
// omitted) to match the .NET default. Data is always present (null when nil).
type GlobalResponse struct {
	Data         any     `json:"data"`
	ErrorMessage *string `json:"errorMessage"`
	Message      *string `json:"message"`
	Success      bool    `json:"success"`
}

// GlobalSearchResponse adds a paging count (the .NET GlobalSearchResponse).
type GlobalSearchResponse struct {
	Data         any     `json:"data"`
	ErrorMessage *string `json:"errorMessage"`
	Message      *string `json:"message"`
	Success      bool    `json:"success"`
	TotalCount   *int    `json:"totalCount"`
}

// Success builds a successful envelope.
func Success(data any, message string) GlobalResponse {
	r := GlobalResponse{Data: data, Success: true}
	if message != "" {
		r.Message = &message
	}
	return r
}

// Failure builds a failed envelope with an error message.
func Failure(errorMessage string) GlobalResponse {
	r := GlobalResponse{Success: false}
	if errorMessage != "" {
		r.ErrorMessage = &errorMessage
	}
	return r
}

// Write serializes resp and selects the status from resp.Success:
// success→200 OK, failure→400 Bad Request — mirroring the .NET
// Ok(resp)/BadRequest(resp) convention. Use WriteStatus for the auth/test
// endpoints that use different codes (401/500).
func Write(w http.ResponseWriter, resp GlobalResponse) {
	status := http.StatusOK
	if !resp.Success {
		status = http.StatusBadRequest
	}
	WriteJSON(w, status, resp)
}

// WriteStatus writes resp with an explicit status code.
func WriteStatus(w http.ResponseWriter, status int, v any) {
	WriteJSON(w, status, v)
}

// WriteJSON marshals v as JSON with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteRaw forwards pre-serialized upstream JSON bytes inside the envelope
// without re-marshaling, guaranteeing byte-identity for source=mt5 passthrough
// (see docs/ARCHITECTURE.md §9 #10). The raw bytes become the "data" value.
func WriteRaw(w http.ResponseWriter, rawData json.RawMessage, success bool) {
	resp := GlobalResponse{Data: rawData, Success: success}
	Write(w, resp)
}
