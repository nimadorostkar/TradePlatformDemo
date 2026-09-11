package domain

import "strconv"

// atoiDefault parses an int, returning 0 on error (matches Convert.ToInt32 of
// empty/zero defaults in the .NET WS dispatchers).
func atoiDefault(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// atoi64 parses an int64, returning 0 on error.
func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// atou64 parses a uint64, returning 0 on error.
func atou64(s string) uint64 {
	n, _ := strconv.ParseUint(s, 10, 64)
	return n
}
