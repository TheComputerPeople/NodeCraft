package corpus.game;

import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;

public final class Calculations {
    private Calculations() {
    }

    public record Division(long quotient, long remainder) {
    }

    /** @blueprint */
    public static Division divide(long a, long b) {
        return new Division(a / b, a % b);
    }

    /** @blueprint */
    public static <T> T first(ArrayList<T> items) {
        return items.get(0);
    }

    /** @blueprint */
    public static CompletableFuture<Long> fetchDouble(long value) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                Thread.sleep(10);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            return value * 2;
        });
    }
}
