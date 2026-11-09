#pragma once
#include <chrono>
#include <future>
#include <thread>

namespace game {

/// Twice value, a little later.
/// @blueprint
inline std::future<long long> fetch_double(long long value) {
    return std::async(std::launch::async, [value]() -> long long {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        return value * 2;
    });
}

}  // namespace game
