package corpus.core;

public final class Text {
    private Text() {
    }

    /** @blueprint pure */
    public static String title(String name) {
        return name.isEmpty() ? name : Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }
}
