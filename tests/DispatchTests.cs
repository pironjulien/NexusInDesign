using System.Runtime.InteropServices;
using NexusInDesign.InDesign;

namespace NexusInDesign.Tests;

/// <summary>
/// The source-generated IDispatch that drives InDesign (Native AOT has no built-in COM interop), checked against COM
/// automation servers every Windows has (scrrun.dll: Scripting.Dictionary, Scripting.FileSystemObject): VARIANT
/// arguments and results, a returned object, the server's own error description, an unregistered ProgID.
/// </summary>
public sealed class DispatchTests
{
    // A non-ASCII text with U+2028, which JavaScript and JSON treat differently.
    private static readonly string Text = "é" + (char)0x2028 + "✓";

    [Fact]
    public void Calls_methods_and_properties_with_variants()
    {
        using var dictionary = DispatchObject.Create("Scripting.Dictionary");
        Assert.NotNull(dictionary);
        dictionary.Invoke("Add", "text", Text);
        dictionary.Invoke("Add", "number", 42);
        dictionary.Invoke("Add", "big", 9_007_199_254_740_993L);
        dictionary.Invoke("Add", "real", 1.5);
        dictionary.Invoke("Add", "flag", true);

        Assert.Equal(5, dictionary.Get("Count"));
        Assert.Equal(Text, dictionary.Invoke("Item", "text"));
        Assert.Equal(42, dictionary.Invoke("Item", "number"));
        Assert.Equal(9_007_199_254_740_993L, dictionary.Invoke("Item", "big"));
        Assert.Equal(1.5, dictionary.Invoke("Item", "real"));
        Assert.Equal(true, dictionary.Invoke("Item", "flag"));
        Assert.Equal(false, dictionary.Invoke("Exists", "TEXT"));
        Assert.Null(dictionary.Invoke("Item", "missing"));
    }

    [Fact]
    public void Returns_objects_and_the_servers_errors()
    {
        using var files = DispatchObject.Create("Scripting.FileSystemObject")!;
        string folder = Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar);
        using (var returned = Assert.IsType<DispatchObject>(files.Invoke("GetFolder", folder)))
        {
            Assert.Equal(Path.GetFullPath(folder), Path.GetFullPath((string)returned.Get("Path")!), ignoreCase: true);
        }

        var missing = Assert.ThrowsAny<COMException>(() => files.Invoke("GetFolder", Path.Combine(folder, Guid.NewGuid().ToString("N"))));
        Assert.False(string.IsNullOrWhiteSpace(missing.Message));
        Assert.ThrowsAny<COMException>(() => files.Invoke("NoSuchMember"));
    }

    [Fact]
    public void An_unregistered_prog_id_gives_null() => Assert.Null(DispatchObject.Create("NexusInDesign.NoSuchServer.1"));
}
