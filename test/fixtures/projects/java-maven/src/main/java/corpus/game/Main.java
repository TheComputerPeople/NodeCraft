package corpus.game;

import corpus.game.graphs.Greeting;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        System.out.println(Greeting.greet("ada"));
    }
}
