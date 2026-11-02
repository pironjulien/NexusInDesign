using System.Text;
using NexusInDesign.InDesign;
using NexusInDesign.Security;

namespace NexusInDesign;

public static class Program
{
    // Same version as NexusInDesign.csproj, the plugin manifests, server.json and the top section of CHANGELOG.md.
    public const string Version = "4.1.1";

    public static int Main(string[] args)
    {
        string command = args.Length > 0 ? args[0] : "";
        switch (command)
        {
            case "--mcp":
            case "serve":
                return Serve();
            case "--version":
            case "-v":
                Console.WriteLine($"NexusInDesign {Version}");
                return 0;
            case "":
            case "--help":
            case "-h":
                Console.WriteLine($"NexusInDesign {Version} - Adobe InDesign for AI agents, through COM only (no panel, no plugin, no network)");
                Console.WriteLine("Usage:");
                Console.WriteLine("  NexusInDesign.exe --mcp      MCP server over stdio (started by Claude Code or Codex)");
                Console.WriteLine("  NexusInDesign.exe --version  version");
                return command.Length == 0 ? 2 : 0;
            default:
                Console.Error.WriteLine($"Unknown command: {command}");
                return 2;
        }
    }

    private static int Serve()
    {
        Application application;
        try
        {
            var config = Config.Load();
            application = new Application(config, new ParentProcessPolicy(config.AllowedParents, config.AllowedParentPaths), new ComInDesignHost());
            application.Start();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[nexus-indesign] Erreur fatale : {exception.Message}");
            return 1;
        }
        using var stop = new CancellationTokenSource();
        int? parent = ParentProcessPolicy.ParentOf(Environment.ProcessId);
        using var watchdog = parent is int parentId ? new ParentWatchdog(parentId, () => Environment.Exit(0)) : null;
        try
        {
            var utf8 = new UTF8Encoding(false);
            using var input = new StreamReader(Console.OpenStandardInput(), utf8);
            using var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = false };
            new McpServer(application).RunStdio(input, output, stop.Token).GetAwaiter().GetResult();
            return 0;
        }
        finally
        {
            application.Stop();
        }
    }
}
