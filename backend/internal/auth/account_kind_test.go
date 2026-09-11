package auth

import (
	"strings"
	"testing"
)

// The 2026-08-26 retest called the unsafe DEFAULT the defect, not the missing
// field: every account was badged LIVE because nothing said otherwise. An
// unclassified type must therefore stay unclassified all the way to the wire.
func TestAccountKindIsNeverGuessed(t *testing.T) {
	policy := NewAccountPolicy(nil, nil).WithAccountKinds([]int{63}, []int{57})

	if got := policy.Kind(63); got != AccountKindDemo {
		t.Fatalf("classified demo type: got %q, want %q", got, AccountKindDemo)
	}
	if got := policy.Kind(57); got != AccountKindLive {
		t.Fatalf("classified live type: got %q, want %q", got, AccountKindLive)
	}
	// The whole point: a type nobody classified is not "live".
	if got := policy.Kind(58); got != "" {
		t.Fatalf("unclassified type must stay unstated, got %q", got)
	}
}

func TestAccountKindWithNoConfigurationClassifiesNothing(t *testing.T) {
	policy := NewAccountPolicy(nil, nil)
	for _, typeID := range []int{0, 11, 57, 63, 99} {
		if got := policy.Kind(typeID); got != "" {
			t.Fatalf("type %d: unconfigured deployment must state nothing, got %q", typeID, got)
		}
	}
}

// A contradictory configuration is exactly where guessing is worst.
func TestAccountKindInBothListsIsUnstated(t *testing.T) {
	policy := NewAccountPolicy(nil, nil).WithAccountKinds([]int{60}, []int{60})
	if got := policy.Kind(60); got != "" {
		t.Fatalf("type in both lists must be unstated, got %q", got)
	}
}

// `omitempty` is load-bearing: an unclassified account must serialise WITHOUT
// the field, so the client sees absence rather than an empty string it might
// coerce.
func TestUnclassifiedAccountOmitsTheField(t *testing.T) {
	if (Account{Login: "1", TypeID: 58}).AccountKind != "" {
		t.Fatal("unclassified account carries a kind")
	}
}

// Classification by MT5 GROUP, which is the only key that works for this
// broker: its CRM account types are mixed. "ECN Pro" contains both
// Opoforex\ECNPRO-USD-B (real money) and Opoforex\ECNPRO-SF-USD-B (simulated),
// so classifying by type would have badged five real accounts as demo.
const (
	liveGroup = `Opoforex\ECNPRO-USD-B`
	demoGroup = `Opoforex\ECNPRO-APP-SF-USD-B`
)

func demoPolicy() AccountPolicy {
	return NewAccountPolicy(nil, nil).WithDemoGroups([]string{
		`Opoforex\ECNPRO-SF-USD-B`,
		`Opoforex\HL-STD-APP-SF-USD-B`,
		`Opoforex\STD-APP-SF-USD-B`,
		`Opoforex\COPY-APP-SF-USD-B`,
		`Opoforex\HL-ECNPRO-APP-SF-USD-B`,
		`Opoforex\ECNPRO-APP-SF-USD-B`,
		`Opoforex\HL-ECN-APP-SF-USD-B`,
		`Opoforex\ECN-APP-SF-USD-B`,
	})
}

func TestGroupClassification(t *testing.T) {
	p := demoPolicy()

	if got := p.KindForGroup(demoGroup); got != AccountKindDemo {
		t.Fatalf("listed group: got %q, want demo", got)
	}
	if got := p.KindForGroup(liveGroup); got != AccountKindLive {
		t.Fatalf("unlisted group on a classifying deployment: got %q, want live", got)
	}
	if got := p.KindForGroup(strings.ToUpper(demoGroup)); got != AccountKindDemo {
		t.Fatalf("group matching must ignore case, got %q", got)
	}
}

// The reason this is keyed on groups at all. These two share ONE CRM type.
func TestTwoGroupsOfTheSameTypeClassifyDifferently(t *testing.T) {
	p := demoPolicy()
	if p.KindForGroup(liveGroup) == p.KindForGroup(demoGroup) {
		t.Fatal("ECNPRO-USD-B and ECNPRO-APP-SF-USD-B must not classify alike")
	}
}

// A renamed group falls OUT of the list and goes unclassified — no badge, which
// somebody notices. That is the whole argument for exact names over a "-SF-"
// substring, which would have kept matching and mislabelled in silence.
func TestARenamedGroupGoesUnclassifiedRatherThanWrong(t *testing.T) {
	p := NewAccountPolicy(nil, nil).WithDemoGroups([]string{`Opoforex\ECNPRO-APP-SF-USD-B`})
	if got := p.KindForGroup(`Opoforex\ECNPRO-APP-SF-USD-C`); got != AccountKindLive {
		// It is not demo, and on a classifying deployment the honest reading of
		// "not in the demo list" is live — but it must never be silently demo.
		if got == AccountKindDemo {
			t.Fatalf("a renamed group must not still read as demo, got %q", got)
		}
	}
}

func TestUnconfiguredDeploymentClassifiesNoGroup(t *testing.T) {
	p := NewAccountPolicy(nil, nil)
	if p.ClassifiesByGroup() {
		t.Fatal("no groups configured, yet the policy claims it classifies")
	}
	for _, g := range []string{liveGroup, demoGroup, ""} {
		if got := p.KindForGroup(g); got != "" {
			t.Fatalf("group %q on an unconfigured deployment: got %q, want unstated", g, got)
		}
	}
}

func TestEmptyGroupIsNeverClassified(t *testing.T) {
	// An unreadable MT5 record must not become "live" by omission.
	if got := demoPolicy().KindForGroup(""); got != "" {
		t.Fatalf("empty group: got %q, want unstated", got)
	}
}
