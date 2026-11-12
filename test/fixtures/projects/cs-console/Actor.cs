namespace Corpus.Game;

/// <summary>Someone in the game, whom graph classes extend.</summary>
/// <param name="name">The actor's name.</param>
/// @blueprint
public abstract class Actor(string name)
{
    /// <summary>The actor's health.</summary>
    /// @blueprint
    public int Health { get; set; } = 100;

    /// <summary>The actor's name.</summary>
    public string Name { get; } = name;

    /// <summary>The actor's name and health.</summary>
    /// <returns>The text.</returns>
    /// @blueprint
    public string Greet()
    {
        return $"{Name} has {Health}";
    }

    /// <summary>Takes damage.</summary>
    /// <param name="damage">How much.</param>
    /// @blueprint overridable
    public virtual void Hit(int damage)
    {
        Health -= damage;
        Console.WriteLine($"{Name} takes {damage}");
    }

    /// <summary>What the actor is.</summary>
    /// <returns>The text.</returns>
    /// @blueprint
    public abstract string Describe();

    /// <summary>A turn: says what the actor is, takes a hit and greets.</summary>
    /// @blueprint
    public void Turn()
    {
        Console.WriteLine($"{Name} is {Describe()}");
        Hit(3);
        Console.WriteLine(Greet());
    }
}
