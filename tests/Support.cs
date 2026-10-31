using System.Reflection;
using System.Text.Json.Nodes;
using NexusInDesign.Security;

namespace NexusInDesign.Tests;

internal sealed class AllowAllParents : IParentVerifier
{
    public JsonObject Verify() => new() { ["verified"] = true, ["test"] = true };
}

/// <summary>A throwaway profile: private storage, a work folder (the only read and write root) and a denied folder.</summary>
internal sealed class Sandbox : IDisposable
{
    public Sandbox(FakeInDesign? inDesign = null, Dictionary<string, string?>? extra = null)
    {
        Root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nexusindesign-tests", Guid.NewGuid().ToString("N"));
        Profile = System.IO.Path.Combine(Root, "profile");
        Work = System.IO.Path.Combine(Profile, "work");
        Secret = System.IO.Path.Combine(Work, "secret");
        Directory.CreateDirectory(Work);
        Directory.CreateDirectory(Secret);
        var environment = new Dictionary<string, string?>
        {
            ["USERPROFILE"] = Profile,
            ["INDESIGN_MCP_READ_ROOTS"] = Work,
            ["INDESIGN_MCP_WRITE_ROOTS"] = Work,
            ["INDESIGN_MCP_DENIED_ROOTS"] = Secret,
            ["INDESIGN_MCP_COMMAND_TIMEOUT_MS"] = "5000",
        };
        foreach (var (key, value) in extra ?? []) environment[key] = value;
        Config = Config.Load(environment);
        InDesign = inDesign ?? new FakeInDesign();
        App = new Application(Config, new AllowAllParents(), InDesign);
        App.Start();
    }

    public string Root { get; }
    public string Profile { get; }
    public string Work { get; }
    public string Secret { get; }
    public Config Config { get; }
    public FakeInDesign InDesign { get; }
    public Application App { get; }

    public string Path(string name) => System.IO.Path.Combine(Work, name);

    public async Task<JsonObject> Call(string tool, JsonObject? arguments = null) => await App.CallTool(tool, arguments ?? []);

    /// <summary>The structured result of a successful call (fails the test with the error text otherwise).</summary>
    public async Task<JsonObject> Ok(string tool, JsonObject? arguments = null)
    {
        var response = await Call(tool, arguments);
        Assert.False(Json.IsTrue(response, "isError"), response.ToJsonString());
        return (JsonObject)response["structuredContent"]!;
    }

    public async Task<string> Fails(string tool, JsonObject? arguments = null)
    {
        var response = await Call(tool, arguments);
        Assert.True(Json.IsTrue(response, "isError"), response.ToJsonString());
        return response["content"]![0]!["text"]!.GetValue<string>();
    }

    public void Dispose()
    {
        App.Stop();
        foreach (var entry in new DirectoryInfo(Work).EnumerateDirectories("*", SearchOption.AllDirectories).Where(entry => entry.LinkTarget is not null).ToList())
            entry.Delete();
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

internal static class Repository
{
    public static string Root { get; } = typeof(Repository).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .First(attribute => attribute.Key == "NexusInDesign.Repository").Value!;

    public static string File(params string[] parts) => Path.Combine([Root, .. parts]);
}
