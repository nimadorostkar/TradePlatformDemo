package domain

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// Workspace persistence. Layouts, drawings, studies, and journal notes lived in
// localStorage, so they did not follow a trader between devices and vanished
// when the browser was cleared. The document is opaque here on purpose: the
// client already versions and migrates its own format, so the server's job is
// to store it whole and hand it back unchanged.

// WorkspaceService stores one layout document per login.
type WorkspaceService struct {
	store WorkspaceStore
	// maxDocumentBytes bounds one document. A layout is kilobytes; anything
	// far past that is a client bug, and accepting it would let one account
	// fill the database.
	maxDocumentBytes int
}

// DefaultMaxWorkspaceBytes is the per-document size limit (1 MiB).
const DefaultMaxWorkspaceBytes = 1 << 20

const workspaceUnavailable = "Workspace persistence is unavailable: no store is configured on this gateway."

// NewWorkspaceService constructs the service. store may be nil, in which case
// the endpoints report the feature as unavailable rather than silently
// accepting documents they cannot keep.
func NewWorkspaceService(store WorkspaceStore) *WorkspaceService {
	return &WorkspaceService{store: store, maxDocumentBytes: DefaultMaxWorkspaceBytes}
}

// Enabled reports whether workspace persistence is backed by a store.
func (s *WorkspaceService) Enabled() bool { return s != nil && s.store != nil }

// workspaceResponse is the wire shape: the document inlined as JSON (not as an
// escaped string), plus the version the client can compare against its copy.
type workspaceResponse struct {
	Login     string          `json:"login"`
	Document  json.RawMessage `json:"document"`
	Version   int64           `json:"version"`
	UpdatedAt string          `json:"updatedAt"`
}

// Get → GET /api/Workspace/get?login=
//
// A login that has never saved a workspace is a success with a null document,
// not an error: "nothing saved yet" is a normal state for a new trader.
func (s *WorkspaceService) Get(ctx context.Context, login string) response.GlobalResponse {
	if !s.Enabled() {
		return failWith(workspaceUnavailable)
	}
	login = strings.TrimSpace(login)
	if login == "" {
		return failWith("login is required.")
	}
	w, found, err := s.store.GetWorkspace(ctx, login)
	if err != nil {
		return catchError(err)
	}
	if !found {
		return response.Success(workspaceResponse{Login: login, Document: nil, Version: 0}, NoDataFoundMessage)
	}
	return response.Success(toWorkspaceResponse(w), SuccessMessage)
}

// WorkspaceRequest is the save body: { login, document }.
type WorkspaceRequest struct {
	Login    string          `json:"login"`
	Document json.RawMessage `json:"document"`
}

// Save → POST /api/Workspace/save
func (s *WorkspaceService) Save(ctx context.Context, req WorkspaceRequest) response.GlobalResponse {
	if !s.Enabled() {
		return failWith(workspaceUnavailable)
	}
	login := strings.TrimSpace(req.Login)
	if login == "" {
		return failWith("login is required.")
	}
	if len(req.Document) == 0 || string(req.Document) == "null" {
		return failWith("document is required.")
	}
	if len(req.Document) > s.maxDocumentBytes {
		return failWith("document exceeds the maximum size.")
	}
	// The document is opaque but must still be valid JSON: storing a malformed
	// blob would turn one bad save into an unreadable workspace forever.
	if !json.Valid(req.Document) {
		return failWith("document must be valid JSON.")
	}
	w, err := s.store.SaveWorkspace(ctx, login, req.Document)
	if err != nil {
		return catchError(err)
	}
	return response.Success(toWorkspaceResponse(w), SuccessMessage)
}

func toWorkspaceResponse(w Workspace) workspaceResponse {
	return workspaceResponse{
		Login:     w.Login,
		Document:  json.RawMessage(w.Document),
		Version:   w.Version,
		UpdatedAt: w.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}
