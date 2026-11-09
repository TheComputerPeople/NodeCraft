//! Formatting names.

/// Capitalizes a name's first letter.
/// @blueprint pure
pub fn title(name: String) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => name,
    }
}
