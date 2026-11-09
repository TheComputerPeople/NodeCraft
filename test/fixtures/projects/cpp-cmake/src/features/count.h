#pragma once

namespace game {

/// Counts.
class Counter {
public:
    /// @blueprint
    double count = 0;

    /// @blueprint
    explicit Counter(double start) : count(start) {}
    virtual ~Counter() = default;
    Counter(const Counter&) = default;
    Counter& operator=(const Counter&) = default;

    /// @blueprint
    double add(double amount) {
        count += amount;
        return count;
    }

    /// @blueprint pure
    double doubled() const { return count * 2; }
};

/// Counts in tens.
class BigCounter : public Counter {
public:
    /// @blueprint
    explicit BigCounter(double start) : Counter(start * 10) {}
};

}  // namespace game
