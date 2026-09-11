package domain

import (
	"context"
	"time"
)

// Persistence for the features that cannot live in a browser tab: price alerts
// (an alert held only in a tab stops working the moment the tab closes, which
// is worse than not offering alerts at all) and workspace layouts (which should
// follow a trader between devices).

// Alert conditions.
const (
	AlertAbove = "above"
	AlertBelow = "below"
)

// Alert statuses.
const (
	AlertActive    = "active"
	AlertTriggered = "triggered"
)

// Alert is one price alert.
type Alert struct {
	ID        int64     `json:"id"`
	Login     string    `json:"login"`
	Symbol    string    `json:"symbol"`
	Condition string    `json:"condition"` // "above" | "below"
	Price     float64   `json:"price"`
	Note      string    `json:"note"`
	Status    string    `json:"status"` // "active" | "triggered"
	CreatedAt time.Time `json:"createdAt"`
	// TriggeredAt / TriggeredPrice are nil until the alert fires. The price is
	// the quote that crossed the level, not the level itself, so a trader can
	// see how far past it the market went.
	TriggeredAt    *time.Time `json:"triggeredAt"`
	TriggeredPrice *float64   `json:"triggeredPrice"`
}

// AlertStore persists price alerts. nil when no database is configured, in
// which case the alert endpoints report the feature as unavailable rather than
// accepting alerts they cannot keep.
type AlertStore interface {
	// ListAlerts returns every alert for a login, newest first.
	ListAlerts(ctx context.Context, login string) ([]Alert, error)
	// ListAlertsTriggeredSince returns alerts that fired strictly after ts.
	ListAlertsTriggeredSince(ctx context.Context, login string, ts time.Time) ([]Alert, error)
	// CreateAlert stores a new active alert and returns it with its id.
	CreateAlert(ctx context.Context, a Alert) (Alert, error)
	// DeleteAlert removes an alert owned by login. It reports whether a row
	// matched, so deleting someone else's alert is a not-found, not a success.
	DeleteAlert(ctx context.Context, id int64, login string) (bool, error)
	// ActiveAlertSymbols returns the distinct symbols with active alerts —
	// the evaluator's work list.
	ActiveAlertSymbols(ctx context.Context) ([]string, error)
	// ActiveAlertsForSymbol returns the active alerts on one symbol.
	ActiveAlertsForSymbol(ctx context.Context, symbol string) ([]Alert, error)
	// MarkAlertTriggered flips an alert to triggered. It reports whether this
	// call was the one that flipped it, so a racing evaluator on another
	// replica cannot fire the same alert twice.
	MarkAlertTriggered(ctx context.Context, id int64, at time.Time, price float64) (bool, error)
}

// Workspace is a trader's stored layout document.
type Workspace struct {
	Login string `json:"login"`
	// Document is opaque to the gateway: the client versions and migrates its
	// own layout format, so the server stores it whole and returns it whole.
	Document  []byte    `json:"document"`
	Version   int64     `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// WorkspaceStore persists one layout document per login.
type WorkspaceStore interface {
	// GetWorkspace returns the stored document, or found=false when the login
	// has never saved one.
	GetWorkspace(ctx context.Context, login string) (Workspace, bool, error)
	// SaveWorkspace upserts the document and returns the stored row.
	SaveWorkspace(ctx context.Context, login string, document []byte) (Workspace, error)
}
