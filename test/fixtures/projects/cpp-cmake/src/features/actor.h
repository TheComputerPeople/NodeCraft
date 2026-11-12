#pragma once

#include <iostream>
#include <string>
#include <utility>

namespace game {

/// Someone in the game, whom graph classes extend.
/// @blueprint
class Actor {
public:
    /// @blueprint
    int health = 100;

    virtual ~Actor() = default;
    Actor(const Actor&) = default;
    Actor& operator=(const Actor&) = default;

    /// @blueprint
    std::string greet() const { return name_ + " has " + std::to_string(health); }

    /// @blueprint overridable
    virtual void hit(int damage) {
        health -= damage;
        std::cout << name_ << " takes " << damage << '\n';
    }

    /// @blueprint
    void turn() {
        std::cout << name_ << " is " << describe() << '\n';
        hit(3);
        std::cout << greet() << '\n';
    }

protected:
    /// @blueprint
    explicit Actor(std::string name) : name_(std::move(name)) {}

    virtual std::string describe() const = 0;

private:
    std::string name_;
};

}  // namespace game
