#pragma once
#include <tuple>

namespace game {

/// a / b and its remainder.
/// @blueprint
/// @outputs quotient remainder
inline std::tuple<int, int> divide(int a, int b) { return {a / b, a % b}; }

}  // namespace game
