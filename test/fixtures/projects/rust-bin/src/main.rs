//! The corpus game: greets Ada, then runs the graphs that use the project's features.
mod features;
mod text;

fn main() {
    println!("{}", greeting_vgraph::greet("ada".to_string()));
    counting_vgraph::Counting::new().start();
    dividing_vgraph::Dividing::new().start();
    firsts_vgraph::Firsts::new().start();
    fetching_vgraph::Fetching::new().start();
    // Delays and futures the graphs wait on.
    vgraph_runtime::run_latent_actions();
}
