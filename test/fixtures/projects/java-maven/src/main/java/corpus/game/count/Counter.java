package corpus.game.count;

public class Counter {
    /** @blueprint */
    public double count;

    /** @blueprint */
    public Counter(double start) {
        count = start;
    }

    /** @blueprint */
    public double add(double amount) {
        count += amount;
        return count;
    }

    /** @blueprint pure */
    public double doubled() {
        return count * 2;
    }
}
