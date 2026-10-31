using System.IO.Compression;
using System.Text;
using NexusInDesign.Verification;

namespace NexusInDesign.Tests;

/// <summary>Minimal valid artifacts, as InDesign would write them.</summary>
internal static class Samples
{
    public static readonly byte[] InddSignature = [0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d];

    public static void WriteIndd(string path, string marker = "")
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var bytes = new byte[256];
        InddSignature.CopyTo(bytes, 0);
        Encoding.ASCII.GetBytes(marker.PadRight(32)[..32]).CopyTo(bytes, 64);
        File.WriteAllBytes(path, bytes);
    }

    public static void WritePdf(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var builder = new StringBuilder("%PDF-1.7\n");
        int catalog = builder.Length;
        builder.Append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        int pages = builder.Length;
        builder.Append("2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n");
        int xref = builder.Length;
        builder.Append("xref\n0 3\n0000000000 65535 f \n");
        builder.Append($"{catalog:D10} 00000 n \n{pages:D10} 00000 n \n");
        builder.Append("trailer\n<< /Size 3 /Root 1 0 R >>\n");
        builder.Append($"startxref\n{xref}\n%%EOF\n");
        File.WriteAllText(path, builder.ToString(), Encoding.Latin1);
    }

    public static void WritePng(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var output = new MemoryStream();
        output.Write([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        void Chunk(string type, byte[] data)
        {
            var length = new byte[4];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(length, (uint)data.Length);
            output.Write(length);
            var typeBytes = Encoding.ASCII.GetBytes(type);
            output.Write(typeBytes);
            output.Write(data);
            var crc = new Crc32();
            crc.Append(typeBytes);
            crc.Append(data);
            var crcBytes = new byte[4];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(crcBytes, crc.GetCurrentHashAsUInt32());
            output.Write(crcBytes);
        }
        Chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0]); // 2x1, 8-bit RGBA
        using var raw = new MemoryStream();
        using (var zlib = new ZLibStream(raw, CompressionLevel.Optimal, leaveOpen: true)) zlib.Write([0, 255, 0, 0, 255, 0, 0, 255, 255]);
        Chunk("IDAT", raw.ToArray());
        Chunk("IEND", []);
        File.WriteAllBytes(path, output.ToArray());
    }

    public static void WriteIdml(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(path, FileMode.Create, FileAccess.ReadWrite);
        using var archive = new ZipArchive(stream, ZipArchiveMode.Create);
        var mimetype = archive.CreateEntry("mimetype", CompressionLevel.NoCompression);
        using (var writer = new StreamWriter(mimetype.Open(), new UTF8Encoding(false))) writer.Write("application/vnd.adobe.indesign-idml-package");
        var designmap = archive.CreateEntry("designmap.xml", CompressionLevel.Optimal);
        using (var writer = new StreamWriter(designmap.Open(), new UTF8Encoding(false)))
            writer.Write("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<?aid style=\"50\" type=\"document\"?>\n<Document xmlns:idPkg=\"http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging\" DOMVersion=\"21.0\"></Document>");
    }
}
