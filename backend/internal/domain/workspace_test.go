package domain

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeWorkspaceStore struct {
	mu    sync.Mutex
	items map[string]Workspace
}

func newFakeWorkspaceStore() *fakeWorkspaceStore {
	return &fakeWorkspaceStore{items: map[string]Workspace{}}
}

func (f *fakeWorkspaceStore) GetWorkspace(_ context.Context, login string) (Workspace, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.items[login]
	return w, ok, nil
}

func (f *fakeWorkspaceStore) SaveWorkspace(_ context.Context, login string, doc []byte) (Workspace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w := f.items[login]
	w.Login = login
	w.Document = doc
	w.Version++
	w.UpdatedAt = time.Now().UTC()
	f.items[login] = w
	return w, nil
}

func TestWorkspaceRoundTrip(t *testing.T) {
	svc := NewWorkspaceService(newFakeWorkspaceStore())
	ctx := context.Background()
	const doc = `{"layout":"grid","charts":[{"symbol":"EURUSD"}]}`

	saved := svc.Save(ctx, WorkspaceRequest{Login: "1010", Document: json.RawMessage(doc)})
	if !saved.Success {
		t.Fatalf("save failed: %+v", saved)
	}
	if v := saved.Data.(workspaceResponse).Version; v != 1 {
		t.Errorf("first save version = %d, want 1", v)
	}

	got := svc.Get(ctx, "1010")
	if !got.Success {
		t.Fatalf("get failed: %+v", got)
	}
	// The document must come back byte-identical: the client versions and
	// migrates its own format, so any server-side reshaping breaks it.
	if stored := string(got.Data.(workspaceResponse).Document); stored != doc {
		t.Errorf("document changed:\n got: %s\nwant: %s", stored, doc)
	}

	// A second save bumps the version so a client can detect a stale copy.
	if v := svc.Save(ctx, WorkspaceRequest{Login: "1010", Document: json.RawMessage(`{}`)}).Data.(workspaceResponse).Version; v != 2 {
		t.Errorf("second save version = %d, want 2", v)
	}
}

// "Nothing saved yet" is a normal state for a new trader, not an error.
func TestWorkspaceGetUnknownLoginSucceedsEmpty(t *testing.T) {
	res := NewWorkspaceService(newFakeWorkspaceStore()).Get(context.Background(), "9999")
	if !res.Success {
		t.Fatalf("an unsaved workspace must not be an error: %+v", res)
	}
	if w := res.Data.(workspaceResponse); w.Document != nil || w.Version != 0 {
		t.Errorf("empty workspace wrong: %+v", w)
	}
}

func TestWorkspaceSaveValidation(t *testing.T) {
	svc := NewWorkspaceService(newFakeWorkspaceStore())
	ctx := context.Background()

	bad := map[string]WorkspaceRequest{
		"no login":       {Document: json.RawMessage(`{}`)},
		"no document":    {Login: "1010"},
		"null document":  {Login: "1010", Document: json.RawMessage(`null`)},
		"invalid JSON":   {Login: "1010", Document: json.RawMessage(`{oops`)},
		"oversized blob": {Login: "1010", Document: json.RawMessage(`"` + strings.Repeat("x", DefaultMaxWorkspaceBytes) + `"`)},
	}
	for name, req := range bad {
		if res := svc.Save(ctx, req); res.Success {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestWorkspaceWithoutStoreReportsUnavailable(t *testing.T) {
	svc := NewWorkspaceService(nil)
	if svc.Enabled() {
		t.Error("a nil store is not enabled")
	}
	if res := svc.Get(context.Background(), "1010"); res.Success || res.ErrorMessage == nil {
		t.Errorf("get must fail with a reason: %+v", res)
	}
	if res := svc.Save(context.Background(), WorkspaceRequest{Login: "1010", Document: json.RawMessage(`{}`)}); res.Success {
		t.Error("save must not claim success when nothing is stored")
	}
}
