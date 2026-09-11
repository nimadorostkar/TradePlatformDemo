package transform

import (
	"fmt"
	"strings"
)

// PathToType reproduces TypeConverter.pathtotypeConveter: if path is non-empty
// and contains a backslash, split on '\' and return the second segment (index 1),
// else "".
func PathToType(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	if strings.Contains(path, "\\") {
		parts := strings.Split(path, "\\")
		if len(parts) > 1 {
			return parts[1]
		}
	}
	return ""
}

// ConvertSessionsMt5ToTv reproduces TradingSessionConverter.ConvertMt5ToTv:
// for each day i (0-based) with sessions, emit "HHMM-HHMM,...:<i+1>", joined by
// "|". Days with no sessions are skipped. Days beyond index 6 are ignored
// (the .NET daysMap has 7 entries; we guard rather than panic).
func ConvertSessionsMt5ToTv(mt5Sessions [][]Session) string {
	daysMap := []string{"1", "2", "3", "4", "5", "6", "7"}
	var tvSessions []string
	for i := 0; i < len(mt5Sessions); i++ {
		if i >= len(daysMap) {
			break
		}
		daySessions := mt5Sessions[i]
		if len(daySessions) == 0 {
			continue
		}
		var sessions []string
		for _, s := range daySessions {
			sessions = append(sessions, fmt.Sprintf("%s-%s", minutesToHHMM(int(s.Open)), minutesToHHMM(int(s.Close))))
		}
		tvSessions = append(tvSessions, fmt.Sprintf("%s:%s", strings.Join(sessions, ","), daysMap[i]))
	}
	return strings.Join(tvSessions, "|")
}

// minutesToHHMM formats minutes-from-midnight as a 4-digit HHMM (no colon).
func minutesToHHMM(minutes int) string {
	return fmt.Sprintf("%02d%02d", minutes/60, minutes%60)
}

// BucketStart maps a unix-second timestamp to the start of its resolution bucket
// (UTC), reproducing TickService.GetBucketStart. Weekly tokens → Monday 00:00,
// monthly tokens → first-of-month 00:00, everything else → day 00:00.
func BucketStart(unixSeconds int64, resolution string) int64 {
	t := timeUTC(unixSeconds)
	res := strings.ToUpper(strings.TrimSpace(resolution))
	switch res {
	case "1W", "W", "7D":
		// Monday 00:00 UTC
		diff := (7 + int(t.Weekday()) - 1) % 7 // Go: Sunday=0, Monday=1
		start := dateOnly(t).AddDate(0, 0, -diff)
		return start.Unix()
	case "1M", "M", "MN", "MN1":
		start := firstOfMonth(t)
		return start.Unix()
	default:
		return dateOnly(t).Unix()
	}
}
