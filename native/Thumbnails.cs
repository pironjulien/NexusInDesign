using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Text.Json.Nodes;

namespace NexusInDesign;

/// <summary>
/// Capped thumbnails of the verified preview PNGs, returned as MCP image content next to their paths so the agent sees
/// the page in the tool result itself (like Figma's get_screenshot). A thumbnail that cannot be made is left out; the
/// PNG path stays the reference.
/// </summary>
internal static class Thumbnails
{
    public const int MaxSide = 1024;
    public const int MaxImages = 4;
    private const long MaxSourceBytes = 64L * 1024 * 1024;
    private const long JpegQuality = 82;

    /// <summary>The PNG previews a successful tool result points to, in page order.</summary>
    public static IReadOnlyList<string> PreviewPaths(string tool, JsonObject result) => tool switch
    {
        "run_layout_script" => Strings(result["previewPaths"]),
        "preview_layout" => Strings(result["preview"]?["paths"]),
        _ => [],
    };

    private static List<string> Strings(JsonNode? node) =>
        (node as JsonArray ?? []).Select(entry => entry?.GetValueKind() == System.Text.Json.JsonValueKind.String ? entry.GetValue<string>() : null)
            .OfType<string>().ToList();

    /// <summary>MCP image content (JPEG, longest side at most <see cref="MaxSide"/> pixels), or null.</summary>
    public static JsonObject? Image(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length == 0 || info.Length > MaxSourceBytes || info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return null;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var source = System.Drawing.Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true);
            double scale = Math.Min(1.0, (double)MaxSide / Math.Max(source.Width, source.Height));
            int width = Math.Max(1, (int)Math.Round(source.Width * scale)), height = Math.Max(1, (int)Math.Round(source.Height * scale));
            using var thumbnail = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(thumbnail))
            {
                graphics.Clear(Color.White);
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.DrawImage(source, 0, 0, width, height);
            }
            var codec = ImageCodecInfo.GetImageEncoders().First(entry => entry.FormatID == ImageFormat.Jpeg.Guid);
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(Encoder.Quality, JpegQuality);
            using var output = new MemoryStream();
            thumbnail.Save(output, codec, parameters);
            return new JsonObject { ["type"] = "image", ["data"] = Convert.ToBase64String(output.ToArray()), ["mimeType"] = "image/jpeg" };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException
            or System.Runtime.InteropServices.ExternalException or OutOfMemoryException or InvalidOperationException)
        {
            return null;
        }
    }
}
