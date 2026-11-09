//! Counters.

/// Counts.
pub struct Counter {
    /// @blueprint
    pub count: f64,
}

impl Counter {
    /// Makes a Counter starting at `start`.
    /// @blueprint
    #[must_use]
    pub fn new(start: f64) -> Self {
        Counter { count: start }
    }

    /// Adds `amount` and gives the new count.
    /// @blueprint
    pub fn add(&mut self, amount: f64) -> f64 {
        self.count += amount;
        self.count
    }

    /// Twice the count.
    /// @blueprint pure
    #[must_use]
    pub fn doubled(&self) -> f64 {
        self.count * 2.0
    }
}

/// Counts in tens.
pub struct BigCounter {
    count: f64,
}

impl BigCounter {
    /// Makes a `BigCounter` starting at ten times `start`.
    /// @blueprint
    #[must_use]
    pub fn new(start: f64) -> Self {
        BigCounter {
            count: start * 10.0,
        }
    }

    /// Adds `amount` and gives the new count.
    /// @blueprint
    pub fn add(&mut self, amount: f64) -> f64 {
        self.count += amount;
        self.count
    }
}
