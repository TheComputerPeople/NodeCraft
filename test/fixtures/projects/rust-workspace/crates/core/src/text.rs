//! Formatting names.

/// Capitalizes a name's first letter.
/// @blueprint pure
#[must_use]
pub fn title(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
