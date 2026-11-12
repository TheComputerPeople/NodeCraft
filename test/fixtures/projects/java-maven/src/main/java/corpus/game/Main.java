package corpus.game;

import corpus.game.graphs.Counting;
import corpus.game.graphs.Dividing;
import corpus.game.graphs.Fetching;
import corpus.game.graphs.Firsts;
import corpus.game.graphs.Greeting;
import corpus.game.graphs.Questing;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        System.out.println(Greeting.greet("ada"));
        new Counting().start();
        new Dividing().start();
        new Firsts().start();
        new Questing().start();
        new Fetching().start();
        // Fetching waits for fetchDouble: its Completed runs with the graphs' other latent actions.
        Fetching.runLatentActions();
    }
}
