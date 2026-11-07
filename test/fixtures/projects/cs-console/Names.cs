namespace Corpus.Game;

/// <summary>Helpers for names.</summary>
public static class Names
{
    /// <summary>The name with its first letter in upper case.</summary>
    /// @blueprint pure
    public static string Title(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        return name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];
    }
}
