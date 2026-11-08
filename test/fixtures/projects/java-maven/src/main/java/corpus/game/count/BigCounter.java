package corpus.game.count;

public class BigCounter extends Counter {
    /** @blueprint */
    public BigCounter(double start) {
        super(start * 10);
    }
}
