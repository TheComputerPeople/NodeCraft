//! Lists.

/// The first item.
/// @blueprint
#[must_use]
pub fn first<T: Clone>(items: &[T]) -> T {
    items[0].clone()
}
