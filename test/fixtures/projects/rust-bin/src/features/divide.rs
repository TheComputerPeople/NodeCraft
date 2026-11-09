//! Division.

/// `a / b` and its remainder.
/// @blueprint
/// @outputs quotient remainder
#[must_use]
pub fn divide(a: i64, b: i64) -> (i64, i64) {
    (a / b, a % b)
}
