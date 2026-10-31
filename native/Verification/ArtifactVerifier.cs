using System.Buffers.Binary;
using System.IO.Compression;

using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign.Verification;

/// <summary>
/// Structural checks of what InDesign wrote, before an export or backup is reported as done: PDF header, objects,
/// %%EOF and xref; PNG chunks, CRCs and decoded size; IDML ZIP structure, CRCs, mimetype and designmap; INDD magic;
/// multipage PNG folders matching exactly the declared files; non-empty package folders. Nothing is trusted from
/// InDesign's own report alone.
/// </summary>
internal static partial class ArtifactVerifier
{
    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    private static readonly byte[] InddSignature = [0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d];
    private const string IdmlMimetype = "application/vnd.adobe.indesign-idml-package";
    private const int MaxZipComment = 0xffff;
    private const long MaxCentralDirectory = 16L * 1024 * 1024;
    private const long MaxRequiredEntry = 64L * 1024 * 1024;
    private const long MaxTotalUncompressed = 1024L * 1024 * 1024;
    private const long MaxPngDecoded = 1024L * 1024 * 1024;
    private const int MaxPackageEntries = 100_000;
    private static readonly HashSet<string> IgnoredPackageFiles = new(StringComparer.OrdinalIgnoreCase) { ".ds_store", "desktop.ini", "thumbs.db" };

    [GeneratedRegex(@"^%PDF-(1\.[0-7]|2\.0)(?:\r\n|\r|\n)")] private static partial Regex PdfHeader();
    [GeneratedRegex(@"\d+\s+\d+\s+obj\b")] private static partial Regex PdfObject();
    [GeneratedRegex(@"startxref\s+(\d+)\s*")] private static partial Regex StartXref();
    [GeneratedRegex(@"^xref(?:\r\n|\r|\n|\s)")] private static partial Regex ClassicXref();
    [GeneratedRegex(@"^\d+\s+\d+\s+obj\b[\s\S]*?/Type\s*/XRef\b")] private static partial Regex StreamXref();
    [GeneratedRegex(@"^xref\s+\d+\s+\d+\s+\d{10}\s+\d{5}\s+[nf](?:\s|\r|\n)")] private static partial Regex ClassicXrefEntry();
    [GeneratedRegex(@"trailer\s*<<[\s\S]*?/Size\s+\d+")] private static partial Regex Trailer();
    [GeneratedRegex(@"/Size\s+\d+")] private static partial Regex XrefSize();
    [GeneratedRegex(@"^[\x00\x09\x0a\x0c\x0d\x20]*$")] private static partial Regex PdfWhitespace();
    [GeneratedRegex(@"^﻿?\s*(?:<\?[^>]+\?>\s*)*<Document\b")] private static partial Regex DesignmapRoot();

    public static JsonObject Verify(string targetPath, string kind, IReadOnlyList<string>? expectedPaths = null) => kind switch
    {
        "pdf" => VerifyPdf(targetPath),
        "png" => VerifyPng(targetPath),
        "idml" => VerifyIdml(targetPath),
        "indd" => VerifyIndd(targetPath),
        "multipage-png" => VerifyMultipagePng(targetPath, expectedPaths),
        "package" => VerifyPackage(targetPath),
        _ => throw Fail("Type d’artefact non pris en charge.", "ARTIFACT_KIND_UNSUPPORTED"),
    };

    private static ToolError Fail(string message, string code, Exception? inner = null) => new(code, message, false, inner);

    private static FileStream OpenRegular(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw Fail("Le chemin de l’artefact est obligatoire.", "ARTIFACT_PATH_INVALID");
        var info = new FileInfo(path);
        if (!info.Exists)
        {
            if (Directory.Exists(path)) throw Fail("L’artefact attendu doit être un fichier.", "ARTIFACT_TYPE_MISMATCH");
            throw Fail("L’artefact est introuvable.", "ARTIFACT_NOT_FOUND");
        }
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw Fail("Les liens symboliques ne sont pas acceptés comme artefacts exportés.", "ARTIFACT_SYMBOLIC_LINK");
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024);
        if (stream.Length == 0)
        {
            stream.Dispose();
            throw Fail("Le fichier exporté est vide.", "ARTIFACT_EMPTY");
        }
        return stream;
    }

    private static byte[] ReadExactly(FileStream stream, long length, long position, string code)
    {
        if (length < 0 || position < 0 || position + length > stream.Length) throw Fail("Le fichier exporté est tronqué.", code);
        var buffer = new byte[length];
        stream.Position = position;
        stream.ReadExactly(buffer);
        return buffer;
    }

    private static JsonObject VerifyPdf(string path)
    {
        using var stream = OpenRegular(path);
        long size = stream.Length;
        if (size < 64) throw Fail("Le PDF est trop court pour contenir une structure valide.", "ARTIFACT_PDF_STRUCTURE_INVALID");
        string head = Encoding.Latin1.GetString(ReadExactly(stream, Math.Min(size, 64 * 1024), 0, "ARTIFACT_PDF_STRUCTURE_INVALID"));
        var header = PdfHeader().Match(head.Length > 16 ? head[..16] : head);
        if (!header.Success) throw Fail("L’en-tête PDF est invalide.", "ARTIFACT_SIGNATURE_MISMATCH");
        if (!PdfObject().IsMatch(head)) throw Fail("Le PDF ne contient aucun objet lisible.", "ARTIFACT_PDF_STRUCTURE_INVALID");

        long tailLength = Math.Min(size, MaxZipComment + 2048);
        string tail = Encoding.Latin1.GetString(ReadExactly(stream, tailLength, size - tailLength, "ARTIFACT_PDF_STRUCTURE_INVALID"));
        int eof = tail.LastIndexOf("%%EOF", StringComparison.Ordinal);
        if (eof < 0 || !PdfWhitespace().IsMatch(tail[(eof + 5)..])) throw Fail("La marque de fin du PDF est absente ou invalide.", "ARTIFACT_PDF_EOF_MISSING");
        string beforeEof = tail[..eof];
        var matches = StartXref().Matches(beforeEof);
        if (matches.Count == 0) throw Fail("Le pointeur startxref du PDF est absent.", "ARTIFACT_PDF_XREF_INVALID");
        if (!long.TryParse(matches[^1].Groups[1].Value, out long xref) || xref < 0 || xref >= size)
            throw Fail("Le pointeur startxref du PDF sort du fichier.", "ARTIFACT_PDF_XREF_INVALID");
        string probe = Encoding.Latin1.GetString(ReadExactly(stream, Math.Min(16 * 1024, size - xref), xref, "ARTIFACT_PDF_XREF_INVALID"));
        bool classic = ClassicXref().IsMatch(probe);
        bool streamXref = StreamXref().IsMatch(probe);
        if (!classic && !streamXref) throw Fail("Le pointeur startxref ne désigne pas une table ou un flux xref.", "ARTIFACT_PDF_XREF_INVALID");
        if (classic)
        {
            if (!ClassicXrefEntry().IsMatch(probe) || !Trailer().IsMatch(beforeEof))
                throw Fail("La table xref classique ou son dictionnaire trailer est invalide.", "ARTIFACT_PDF_XREF_INVALID");
        }
        else if (!XrefSize().IsMatch(probe)) throw Fail("Le flux xref ne contient pas de taille.", "ARTIFACT_PDF_XREF_INVALID");
        return new JsonObject { ["valid"] = true, ["kind"] = "pdf", ["sizeBytes"] = size, ["version"] = header.Groups[1].Value, ["xrefOffset"] = xref };
    }

    private sealed record PngHeader(uint Width, uint Height, int BitDepth, int ColorType, int Interlace);

    private static PngHeader ParsePngHeader(byte[] data)
    {
        uint width = BinaryPrimitives.ReadUInt32BigEndian(data);
        uint height = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(4));
        int bitDepth = data[8], colorType = data[9], compression = data[10], filter = data[11], interlace = data[12];
        if (width == 0 || height == 0 || width > 0x7fffffff || height > 0x7fffffff)
            throw Fail("Les dimensions PNG sont invalides.", "ARTIFACT_PNG_IHDR_INVALID");
        int[]? depths = colorType switch
        {
            0 => [1, 2, 4, 8, 16],
            2 => [8, 16],
            3 => [1, 2, 4, 8],
            4 => [8, 16],
            6 => [8, 16],
            _ => null,
        };
        if (depths is null || !depths.Contains(bitDepth) || compression != 0 || filter != 0 || interlace is not (0 or 1))
            throw Fail("Les paramètres IHDR du PNG sont invalides.", "ARTIFACT_PNG_IHDR_INVALID");
        return new PngHeader(width, height, bitDepth, colorType, interlace);
    }

    private sealed record PngPass(long RowCount, long RowBytes);

    private static (long Size, List<PngPass> Passes) PngLayout(PngHeader header)
    {
        int channels = header.ColorType switch { 0 => 1, 2 => 3, 3 => 1, 4 => 2, _ => 4 };
        long bitsPerPixel = (long)channels * header.BitDepth;
        PngPass Pass(long startX, long startY, long stepX, long stepY)
        {
            long width = header.Width <= startX ? 0 : (header.Width - startX + stepX - 1) / stepX;
            long height = header.Height <= startY ? 0 : (header.Height - startY + stepY - 1) / stepY;
            long rowBytes = width == 0 ? 0 : 1 + ((width * bitsPerPixel) + 7) / 8;
            return new PngPass(height, rowBytes);
        }
        var passes = header.Interlace == 0
            ? [Pass(0, 0, 1, 1)]
            : new[] { (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2) }
                .Select(pass => Pass(pass.Item1, pass.Item2, pass.Item3, pass.Item4))
                .Where(pass => pass.RowCount > 0 && pass.RowBytes > 0).ToList();
        long size = 0;
        foreach (var pass in passes) size += pass.RowCount * pass.RowBytes;
        if (size > MaxPngDecoded || size < 0) throw Fail("Le PNG dépasse la limite de validation décompressée.", "ARTIFACT_PNG_RESOURCE_LIMIT");
        return (size, passes);
    }

    private static JsonObject VerifyPng(string path)
    {
        using var stream = OpenRegular(path);
        long size = stream.Length;
        if (size < PngSignature.Length + 12) throw Fail("Le PNG est tronqué.", "ARTIFACT_PNG_TRUNCATED");
        if (!ReadExactly(stream, 8, 0, "ARTIFACT_PNG_TRUNCATED").AsSpan().SequenceEqual(PngSignature))
            throw Fail("La signature du fichier PNG est invalide.", "ARTIFACT_SIGNATURE_MISMATCH");
        long position = 8;
        int chunkCount = 0, idatCount = 0;
        PngHeader? header = null;
        bool sawPalette = false, idatEnded = false, sawIend = false;
        var idat = new List<(long Position, long Length)>();
        while (position < size)
        {
            if (size - position < 12) throw Fail("Le dernier chunk PNG est tronqué.", "ARTIFACT_PNG_TRUNCATED");
            var chunk = ReadExactly(stream, 8, position, "ARTIFACT_PNG_TRUNCATED");
            uint length = BinaryPrimitives.ReadUInt32BigEndian(chunk);
            var typeBytes = chunk.AsSpan(4, 4).ToArray();
            string type = Encoding.ASCII.GetString(typeBytes);
            if (length > 0x7fffffff || !typeBytes.All(b => b is (>= 65 and <= 90) or (>= 97 and <= 122)) || (typeBytes[2] & 0x20) != 0)
                throw Fail("Le type ou la taille d’un chunk PNG est invalide.", "ARTIFACT_PNG_CHUNK_INVALID");
            long dataPosition = position + 8, crcPosition = dataPosition + length, next = crcPosition + 4;
            if (next > size) throw Fail("Un chunk PNG est tronqué.", "ARTIFACT_PNG_TRUNCATED");
            uint expectedCrc = BinaryPrimitives.ReadUInt32BigEndian(ReadExactly(stream, 4, crcPosition, "ARTIFACT_PNG_TRUNCATED"));
            var crc = new Crc32();
            crc.Append(typeBytes);
            stream.Position = dataPosition;
            CopyRange(stream, length, crc.Append);
            if (crc.GetCurrentHashAsUInt32() != expectedCrc) throw Fail($"Le CRC du chunk {type} est invalide.", "ARTIFACT_PNG_CRC_INVALID");
            if (chunkCount == 0 && type != "IHDR") throw Fail("IHDR doit être le premier chunk PNG.", "ARTIFACT_PNG_CHUNK_ORDER_INVALID");
            if ((typeBytes[0] & 0x20) == 0 && type is not ("IHDR" or "PLTE" or "IDAT" or "IEND"))
                throw Fail($"Le chunk critique PNG {type} est inconnu.", "ARTIFACT_PNG_CHUNK_INVALID");
            if (type == "IHDR")
            {
                if (header is not null || length != 13 || chunkCount != 0) throw Fail("Le chunk IHDR est invalide.", "ARTIFACT_PNG_IHDR_INVALID");
                header = ParsePngHeader(ReadExactly(stream, 13, dataPosition, "ARTIFACT_PNG_TRUNCATED"));
            }
            else if (type == "PLTE")
            {
                if (header is null || sawPalette || idatCount > 0 || length == 0 || length % 3 != 0 || length > 768 || header.ColorType is 0 or 4
                    || (header.ColorType == 3 && length / 3 > (1 << header.BitDepth)))
                    throw Fail("Le chunk PLTE est invalide ou mal placé.", "ARTIFACT_PNG_CHUNK_ORDER_INVALID");
                sawPalette = true;
            }
            else if (type == "IDAT")
            {
                if (header is null || sawIend || idatEnded || (header.ColorType == 3 && !sawPalette))
                    throw Fail("Un chunk IDAT est mal placé.", "ARTIFACT_PNG_CHUNK_ORDER_INVALID");
                idatCount++;
                idat.Add((dataPosition, length));
            }
            else
            {
                if (idatCount > 0 && type != "IEND") idatEnded = true;
                if (type == "IEND")
                {
                    if (length != 0 || idatCount == 0 || sawIend) throw Fail("Le chunk IEND est invalide.", "ARTIFACT_PNG_CHUNK_ORDER_INVALID");
                    sawIend = true;
                    if (next != size) throw Fail("Des octets suivent le chunk IEND.", "ARTIFACT_PNG_TRAILING_DATA");
                }
            }
            chunkCount++;
            position = next;
            if (sawIend) break;
        }
        if (header is null || !sawIend || idatCount == 0) throw Fail("La structure PNG est incomplète.", "ARTIFACT_PNG_STRUCTURE_INVALID");
        ValidatePngData(stream, idat, PngLayout(header));
        return new JsonObject { ["valid"] = true, ["kind"] = "png", ["sizeBytes"] = size, ["width"] = header.Width, ["height"] = header.Height, ["chunkCount"] = chunkCount };
    }

    private static void CopyRange(Stream stream, long length, Action<byte[]> sink)
    {
        var buffer = new byte[64 * 1024];
        long remaining = length;
        while (remaining > 0)
        {
            int read = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
            if (read == 0) throw Fail("Le fichier exporté est tronqué.", "ARTIFACT_TRUNCATED");
            sink(read == buffer.Length ? buffer : buffer[..read]);
            remaining -= read;
        }
    }

    /// <summary>A read-only view of several ranges of a file, one after the other (the IDAT chunks).</summary>
    private sealed class RangeStream(FileStream source, List<(long Position, long Length)> ranges) : Stream
    {
        private int index;
        private long offset;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int start, int count)
        {
            while (index < ranges.Count && offset >= ranges[index].Length) { index++; offset = 0; }
            if (index >= ranges.Count) return 0;
            var (position, length) = ranges[index];
            source.Position = position + offset;
            int read = source.Read(buffer, start, (int)Math.Min(count, length - offset));
            if (read == 0) throw Fail("Le PNG est tronqué.", "ARTIFACT_PNG_TRUNCATED");
            offset += read;
            return read;
        }
    }

    private static void ValidatePngData(FileStream stream, List<(long Position, long Length)> ranges, (long Size, List<PngPass> Passes) layout)
    {
        long decoded = 0, rowsRemaining = layout.Passes.Count > 0 ? layout.Passes[0].RowCount : 0, bytesInRow = 0;
        int passIndex = 0;
        try
        {
            using var inflater = new ZLibStream(new RangeStream(stream, ranges), CompressionMode.Decompress);
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = inflater.Read(buffer, 0, buffer.Length)) > 0)
            {
                decoded += read;
                if (decoded > layout.Size) throw Fail("Les données décompressées du PNG dépassent ses dimensions.", "ARTIFACT_PNG_DATA_INVALID");
                int position = 0;
                while (position < read)
                {
                    while (rowsRemaining == 0 && passIndex + 1 < layout.Passes.Count) { passIndex++; rowsRemaining = layout.Passes[passIndex].RowCount; }
                    if (bytesInRow == 0)
                    {
                        if (rowsRemaining == 0 || buffer[position] > 4) throw Fail("Un octet de filtre PNG est invalide.", "ARTIFACT_PNG_DATA_INVALID");
                        position++;
                        rowsRemaining--;
                        bytesInRow = layout.Passes[passIndex].RowBytes - 1;
                    }
                    long consumed = Math.Min(bytesInRow, read - position);
                    bytesInRow -= consumed;
                    position += (int)consumed;
                }
            }
        }
        catch (ToolError) { throw; }
        catch (Exception exception) when (exception is InvalidDataException or IOException)
        {
            throw Fail("Le flux IDAT du PNG est invalide.", "ARTIFACT_PNG_DATA_INVALID", exception);
        }
        if (decoded != layout.Size || rowsRemaining != 0 || bytesInRow != 0 || passIndex != layout.Passes.Count - 1)
            throw Fail("Le flux IDAT du PNG ne correspond pas à ses dimensions.", "ARTIFACT_PNG_DATA_INVALID");
    }

    private static JsonObject VerifyIndd(string path)
    {
        using var stream = OpenRegular(path);
        if (stream.Length < 64) throw Fail("La copie INDD est trop courte.", "ARTIFACT_INDD_STRUCTURE_INVALID");
        if (!ReadExactly(stream, InddSignature.Length, 0, "ARTIFACT_INDD_STRUCTURE_INVALID").AsSpan().SequenceEqual(InddSignature))
            throw Fail("La signature binaire de la copie INDD est invalide.", "ARTIFACT_INDD_SIGNATURE_MISMATCH");
        return new JsonObject { ["valid"] = true, ["kind"] = "indd", ["sizeBytes"] = stream.Length };
    }

    private sealed class ZipEntry
    {
        public required string Name { get; init; }
        public int Flags { get; init; }
        public int Method { get; init; }
        public uint Crc { get; init; }
        public long CompressedSize { get; init; }
        public long UncompressedSize { get; init; }
        public long LocalOffset { get; init; }
        public long DataOffset { get; set; }
    }

    private static string ZipName(byte[] bytes, int flags) => (flags & 0x0800) != 0 ? Encoding.UTF8.GetString(bytes) : Encoding.Latin1.GetString(bytes);

    private static void AssertSafeZipName(string name)
    {
        var segments = name.Replace('\\', '/').Split('/');
        if (name.Length == 0 || name.Contains('\0', StringComparison.Ordinal) || name.StartsWith('/') || name.StartsWith('\\')
            || (name.Length >= 2 && char.IsAsciiLetter(name[0]) && name[1] == ':') || segments.Contains(".."))
            throw Fail("Une entrée IDML contient un chemin ZIP dangereux.", "ARTIFACT_IDML_PATH_INVALID");
    }

    private static byte[] ReadZipEntry(FileStream stream, ZipEntry entry)
    {
        if (entry.UncompressedSize > MaxRequiredEntry || entry.CompressedSize > MaxRequiredEntry)
            throw Fail("Une entrée IDML requise dépasse la limite de validation.", "ARTIFACT_IDML_RESOURCE_LIMIT");
        var compressed = ReadExactly(stream, entry.CompressedSize, entry.DataOffset, "ARTIFACT_IDML_ZIP_INVALID");
        byte[] data;
        try
        {
            if (entry.Method == 0) data = compressed;
            else
            {
                using var inflater = new DeflateStream(new MemoryStream(compressed), CompressionMode.Decompress);
                using var output = new MemoryStream();
                var buffer = new byte[64 * 1024];
                int read;
                while ((read = inflater.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                    if (output.Length > MaxRequiredEntry) throw Fail("Une entrée IDML requise dépasse la limite de validation.", "ARTIFACT_IDML_RESOURCE_LIMIT");
                }
                data = output.ToArray();
            }
        }
        catch (ToolError) { throw; }
        catch (Exception exception) when (exception is InvalidDataException or IOException)
        {
            throw Fail($"L’entrée IDML {entry.Name} ne peut pas être décompressée.", "ARTIFACT_IDML_ZIP_INVALID", exception);
        }
        if (data.LongLength != entry.UncompressedSize || Crc32.HashToUInt32(data) != entry.Crc)
            throw Fail($"L’entrée IDML {entry.Name} est corrompue.", "ARTIFACT_IDML_CRC_INVALID");
        return data;
    }

    private static void VerifyZipEntryCrc(FileStream stream, ZipEntry entry)
    {
        long decoded = 0;
        var crc = new Crc32();
        try
        {
            Stream source = new RangeStream(stream, [(entry.DataOffset, entry.CompressedSize)]);
            using var decoder = entry.Method == 0 ? source : new DeflateStream(source, CompressionMode.Decompress);
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = decoder.Read(buffer, 0, buffer.Length)) > 0)
            {
                decoded += read;
                if (decoded > entry.UncompressedSize) throw Fail($"L’entrée IDML {entry.Name} dépasse sa taille déclarée.", "ARTIFACT_IDML_CRC_INVALID");
                crc.Append(buffer.AsSpan(0, read));
            }
        }
        catch (ToolError error) when (error.Code == "ARTIFACT_PNG_TRUNCATED")
        {
            throw Fail($"L’entrée IDML {entry.Name} ne peut pas être décompressée.", "ARTIFACT_IDML_ZIP_INVALID", error);
        }
        catch (ToolError) { throw; }
        catch (Exception exception) when (exception is InvalidDataException or IOException)
        {
            throw Fail($"L’entrée IDML {entry.Name} ne peut pas être décompressée.", "ARTIFACT_IDML_ZIP_INVALID", exception);
        }
        if (decoded != entry.UncompressedSize || crc.GetCurrentHashAsUInt32() != entry.Crc)
            throw Fail($"L’entrée IDML {entry.Name} est corrompue.", "ARTIFACT_IDML_CRC_INVALID");
    }

    private static JsonObject VerifyIdml(string path)
    {
        using var stream = OpenRegular(path);
        long size = stream.Length;
        if (size < 22) throw Fail("Le conteneur IDML est trop court.", "ARTIFACT_IDML_ZIP_INVALID");
        long tailLength = Math.Min(size, MaxZipComment + 22);
        var tail = ReadExactly(stream, tailLength, size - tailLength, "ARTIFACT_IDML_ZIP_INVALID");
        int eocd = -1;
        for (int index = tail.Length - 22; index >= 0; index--)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(index)) != 0x06054b50) continue;
            int commentLength = BinaryPrimitives.ReadUInt16LittleEndian(tail.AsSpan(index + 20));
            if (index + 22 + commentLength == tail.Length) { eocd = index; break; }
        }
        if (eocd < 0) throw Fail("La fin du conteneur ZIP IDML est introuvable.", "ARTIFACT_IDML_ZIP_INVALID");
        long eocdAbsolute = size - tailLength + eocd;
        var e = tail.AsSpan(eocd);
        int disk = BinaryPrimitives.ReadUInt16LittleEndian(e[4..]), centralDisk = BinaryPrimitives.ReadUInt16LittleEndian(e[6..]);
        int onDisk = BinaryPrimitives.ReadUInt16LittleEndian(e[8..]), count = BinaryPrimitives.ReadUInt16LittleEndian(e[10..]);
        uint centralSize = BinaryPrimitives.ReadUInt32LittleEndian(e[12..]), centralOffset = BinaryPrimitives.ReadUInt32LittleEndian(e[16..]);
        if (disk != 0 || centralDisk != 0 || onDisk != count || count == 0 || count == 0xffff || centralSize == 0xffffffff || centralOffset == 0xffffffff)
            throw Fail("Les archives IDML multidisques ou ZIP64 ne sont pas prises en charge.", "ARTIFACT_IDML_ZIP_UNSUPPORTED");
        if (centralSize > MaxCentralDirectory || (long)centralOffset + centralSize != eocdAbsolute)
            throw Fail("Le répertoire central IDML est invalide.", "ARTIFACT_IDML_ZIP_INVALID");
        var central = ReadExactly(stream, centralSize, centralOffset, "ARTIFACT_IDML_ZIP_INVALID");
        var entries = new Dictionary<string, ZipEntry>(StringComparer.Ordinal);
        var order = new List<ZipEntry>();
        long total = 0;
        int position = 0;
        for (int index = 0; index < count; index++)
        {
            if (position + 46 > central.Length || BinaryPrimitives.ReadUInt32LittleEndian(central.AsSpan(position)) != 0x02014b50)
                throw Fail("Une entrée du répertoire central IDML est invalide.", "ARTIFACT_IDML_ZIP_INVALID");
            var c = central.AsSpan(position);
            int flags = BinaryPrimitives.ReadUInt16LittleEndian(c[8..]), method = BinaryPrimitives.ReadUInt16LittleEndian(c[10..]);
            uint crc = BinaryPrimitives.ReadUInt32LittleEndian(c[16..]);
            uint compressed = BinaryPrimitives.ReadUInt32LittleEndian(c[20..]), uncompressed = BinaryPrimitives.ReadUInt32LittleEndian(c[24..]);
            int nameLength = BinaryPrimitives.ReadUInt16LittleEndian(c[28..]), extra = BinaryPrimitives.ReadUInt16LittleEndian(c[30..]);
            int comment = BinaryPrimitives.ReadUInt16LittleEndian(c[32..]), diskStart = BinaryPrimitives.ReadUInt16LittleEndian(c[34..]);
            uint local = BinaryPrimitives.ReadUInt32LittleEndian(c[42..]);
            int next = position + 46 + nameLength + extra + comment;
            if (next > central.Length || (flags & 1) != 0 || method is not (0 or 8) || diskStart != 0
                || compressed == 0xffffffff || uncompressed == 0xffffffff || local == 0xffffffff)
                throw Fail("Une entrée ZIP IDML utilise une structure non prise en charge.", "ARTIFACT_IDML_ZIP_UNSUPPORTED");
            string name = ZipName(central.AsSpan(position + 46, nameLength).ToArray(), flags);
            AssertSafeZipName(name);
            if (entries.ContainsKey(name)) throw Fail("Le conteneur IDML contient une entrée dupliquée.", "ARTIFACT_IDML_ZIP_INVALID");
            var entry = new ZipEntry { Name = name, Flags = flags, Method = method, Crc = crc, CompressedSize = compressed, UncompressedSize = uncompressed, LocalOffset = local };
            entries[name] = entry;
            order.Add(entry);
            total += uncompressed;
            if (total > MaxTotalUncompressed) throw Fail("Le contenu IDML dépasse la limite de validation.", "ARTIFACT_IDML_RESOURCE_LIMIT");
            position = next;
        }
        if (position != central.Length) throw Fail("Le répertoire central IDML contient des données inattendues.", "ARTIFACT_IDML_ZIP_INVALID");
        var ranges = new List<(long Start, long End)>();
        foreach (var entry in order)
        {
            if (entry.LocalOffset + 30 > centralOffset) throw Fail("Une entrée locale IDML sort du conteneur.", "ARTIFACT_IDML_ZIP_INVALID");
            var header = ReadExactly(stream, 30, entry.LocalOffset, "ARTIFACT_IDML_ZIP_INVALID");
            if (BinaryPrimitives.ReadUInt32LittleEndian(header) != 0x04034b50) throw Fail("Un en-tête local IDML est invalide.", "ARTIFACT_IDML_ZIP_INVALID");
            int flags = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(6)), method = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(8));
            uint crc = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(14));
            uint compressed = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(18)), uncompressed = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(22));
            int nameLength = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(26)), extra = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(28));
            string localName = ZipName(ReadExactly(stream, nameLength, entry.LocalOffset + 30, "ARTIFACT_IDML_ZIP_INVALID"), flags);
            long dataOffset = entry.LocalOffset + 30 + nameLength + extra, dataEnd = dataOffset + entry.CompressedSize;
            bool sizesMismatch = (flags & 0x0008) == 0 && (crc != entry.Crc || compressed != entry.CompressedSize || uncompressed != entry.UncompressedSize);
            if (localName != entry.Name || method != entry.Method || flags != entry.Flags || sizesMismatch || dataEnd > centralOffset)
                throw Fail("Un en-tête local IDML ne correspond pas au répertoire central.", "ARTIFACT_IDML_ZIP_INVALID");
            entry.DataOffset = dataOffset;
            ranges.Add((entry.LocalOffset, dataEnd));
        }
        ranges.Sort((left, right) => left.Start.CompareTo(right.Start));
        for (int index = 1; index < ranges.Count; index++)
            if (ranges[index].Start < ranges[index - 1].End) throw Fail("Des entrées IDML locales se chevauchent.", "ARTIFACT_IDML_ZIP_INVALID");
        foreach (var entry in order) VerifyZipEntryCrc(stream, entry);
        if (!entries.TryGetValue("mimetype", out var mimetype) || !entries.TryGetValue("designmap.xml", out var designmap))
            throw Fail("Le paquet IDML doit contenir mimetype et designmap.xml à sa racine.", "ARTIFACT_IDML_REQUIRED_ENTRY_MISSING");
        if (mimetype.Method != 0 || mimetype.LocalOffset != 0)
            throw Fail("L’entrée mimetype IDML doit être la première et stockée sans compression.", "ARTIFACT_IDML_MIMETYPE_INVALID");
        if (Encoding.UTF8.GetString(ReadZipEntry(stream, mimetype)) != IdmlMimetype)
            throw Fail("Le type MIME du paquet IDML est invalide.", "ARTIFACT_IDML_MIMETYPE_INVALID");
        string map = Encoding.UTF8.GetString(ReadZipEntry(stream, designmap));
        if (!DesignmapRoot().IsMatch(map) || !map.Contains("http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging", StringComparison.Ordinal))
            throw Fail("designmap.xml ne décrit pas un paquet IDML Adobe.", "ARTIFACT_IDML_DESIGNMAP_INVALID");
        return new JsonObject { ["valid"] = true, ["kind"] = "idml", ["sizeBytes"] = size, ["entryCount"] = count };
    }

    private static DirectoryInfo OpenDirectory(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw Fail("Le chemin de l’artefact est obligatoire.", "ARTIFACT_PATH_INVALID");
        var info = new DirectoryInfo(path);
        if (!info.Exists)
        {
            if (File.Exists(path)) throw Fail("L’artefact attendu doit être un dossier.", "ARTIFACT_TYPE_MISMATCH");
            throw Fail("L’artefact est introuvable.", "ARTIFACT_NOT_FOUND");
        }
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw Fail("Les liens symboliques ne sont pas acceptés comme artefacts exportés.", "ARTIFACT_SYMBOLIC_LINK");
        return info;
    }

    private static string Comparable(string path) => Path.GetFullPath(path).ToLowerInvariant();

    private static JsonObject VerifyMultipagePng(string path, IReadOnlyList<string>? expectedPaths)
    {
        var directory = OpenDirectory(path);
        if (expectedPaths is null || expectedPaths.Count == 0 || expectedPaths.Any(entry => !Path.IsPathFullyQualified(entry.Replace('/', '\\'))))
            throw Fail("La liste absolue des PNG déclarés par InDesign est obligatoire.", "ARTIFACT_EXPECTED_PATHS_INVALID");
        var entries = directory.GetFileSystemInfos();
        if (entries.Length == 0) throw Fail("Le dossier multipage ne contient aucun PNG.", "ARTIFACT_MULTIPAGE_EMPTY");
        if (entries.Any(entry => entry is not FileInfo || !entry.Extension.Equals(".png", StringComparison.OrdinalIgnoreCase)))
            throw Fail("Le dossier multipage contient une entrée qui n’est pas un fichier PNG.", "ARTIFACT_MULTIPAGE_UNEXPECTED_ENTRY");
        var expected = expectedPaths.Select(entry => Comparable(entry.Replace('/', '\\'))).ToList();
        var actual = entries.Select(entry => Comparable(entry.FullName)).ToHashSet(StringComparer.Ordinal);
        if (expected.Distinct(StringComparer.Ordinal).Count() != expected.Count || expected.Count != actual.Count || expected.Any(entry => !actual.Contains(entry)))
            throw Fail("Les PNG présents ne correspondent pas exactement aux fichiers déclarés par InDesign.", "ARTIFACT_PATH_SET_MISMATCH");
        foreach (var entry in entries)
        {
            try { VerifyPng(entry.FullName); }
            catch (ToolError error) { throw Fail($"Le fichier {entry.Name} n’est pas un PNG valide.", "ARTIFACT_MULTIPAGE_INVALID", error); }
        }
        return new JsonObject
        {
            ["valid"] = true, ["kind"] = "multipage-png", ["entryCount"] = entries.Length,
            ["pngCandidateCount"] = entries.Length, ["validPngCount"] = entries.Length,
        };
    }

    private static JsonObject VerifyPackage(string path)
    {
        OpenDirectory(path);
        var pending = new Stack<string>([Path.GetFullPath(path)]);
        int entryCount = 0, fileCount = 0, useful = 0;
        long totalSize = 0;
        while (pending.Count > 0)
        {
            foreach (var entry in new DirectoryInfo(pending.Pop()).GetFileSystemInfos())
            {
                if (++entryCount > MaxPackageEntries) throw Fail("Le package dépasse la limite de validation.", "ARTIFACT_PACKAGE_RESOURCE_LIMIT");
                if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    throw Fail("Les liens symboliques ne sont pas acceptés comme artefacts exportés.", "ARTIFACT_SYMBOLIC_LINK");
                if (entry is DirectoryInfo) pending.Push(entry.FullName);
                else if (entry is FileInfo file)
                {
                    fileCount++;
                    totalSize += file.Length;
                    if (file.Length > 0 && !IgnoredPackageFiles.Contains(file.Name)) useful++;
                }
            }
        }
        if (entryCount == 0) throw Fail("Le dossier package est vide.", "ARTIFACT_PACKAGE_EMPTY");
        if (useful == 0) throw Fail("Le dossier package ne contient aucun fichier utile non vide.", "ARTIFACT_PACKAGE_CONTENT_INVALID");
        return new JsonObject
        {
            ["valid"] = true, ["kind"] = "package", ["entryCount"] = entryCount, ["fileCount"] = fileCount,
            ["usefulFileCount"] = useful, ["totalSizeBytes"] = totalSize,
        };
    }
}
