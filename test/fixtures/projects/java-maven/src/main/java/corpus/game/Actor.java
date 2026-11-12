package corpus.game;

/**
 * Someone in the game, whom graph classes extend.
 *
 * @blueprint
 */
public abstract class Actor {
    /** @blueprint */
    public long health = 100;

    private final String name;

    /** @blueprint */
    protected Actor(String name) {
        this.name = name;
    }

    /** @blueprint */
    public String greet() {
        return name + " has " + health;
    }

    /** @blueprint overridable */
    public void hit(int damage) {
        health -= damage;
        System.out.println(name + " takes " + damage);
    }

    protected abstract String describe();

    /** @blueprint */
    public void turn() {
        System.out.println(name + " is " + describe());
        hit(3);
        System.out.println(greet());
    }
}
