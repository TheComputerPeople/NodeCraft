namespace Corpus.Core;

/// <summary>Text helpers.</summary>
public static class Text
{
    /// @blueprint pure
    public static string Title(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        return name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];
    }
}
