package features

import "errors"

// ErrDivisionByZero is Divide's error for b == 0.
var ErrDivisionByZero = errors.New("division by zero")

// Divide gives a / b and its remainder.
// @blueprint
func Divide(a, b int) (quotient, remainder int, err error) {
	if b == 0 {
		return 0, 0, ErrDivisionByZero
	}
	return a / b, a % b, nil
}
