package realtime

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
)

// NATSBus is a Bus backed by NATS, giving cross-pod fan-out: any pod's poller
// publishes per-subscription data and every pod's hub subscribes.
type NATSBus struct {
	nc *nats.Conn
}

// NewNATSBus connects to the NATS server at url.
func NewNATSBus(url string) (*NATSBus, error) {
	nc, err := nats.Connect(url,
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.Name("tradeplatform-gateway"),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}
	return &NATSBus{nc: nc}, nil
}

// Publish sends data on subject.
func (b *NATSBus) Publish(_ context.Context, subject string, data []byte) error {
	return b.nc.Publish(subject, data)
}

// Subscribe registers handler for subject.
func (b *NATSBus) Subscribe(subject string, handler func([]byte)) (func(), error) {
	sub, err := b.nc.Subscribe(subject, func(m *nats.Msg) { handler(m.Data) })
	if err != nil {
		return nil, err
	}
	return func() { _ = sub.Unsubscribe() }, nil
}

// Close drains and closes the connection.
func (b *NATSBus) Close() error {
	return b.nc.Drain()
}
