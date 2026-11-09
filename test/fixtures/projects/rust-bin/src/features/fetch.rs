//! Fetching, later.
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

/// A future that is ready after a while, with no reactor.
struct Later {
    until: Instant,
}

impl Future for Later {
    type Output = ();
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        if Instant::now() >= self.until {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

/// Twice `value`, a little later.
/// @blueprint
pub async fn fetch_double(value: i64) -> i64 {
    Later {
        until: Instant::now() + Duration::from_millis(10),
    }
    .await;
    value * 2
}
