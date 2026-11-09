// Package text formats names.
package text

import "strings"

// Title capitalizes a name's first letter.
// @blueprint pure
func Title(name string) string {
	if name == "" {
		return name
	}
	return strings.ToUpper(name[:1]) + name[1:]
}
