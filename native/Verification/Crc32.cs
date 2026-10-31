namespace NexusInDesign.Verification;

/// <summary>CRC-32 (ISO-HDLC, the PNG and ZIP checksum), incremental.</summary>
internal sealed class Crc32
{
    private static readonly uint[] Table = BuildTable();
    private uint value = 0xffffffff;

    private static uint[] BuildTable()
    {
        var table = new uint[256];
        for (uint index = 0; index < 256; index++)
        {
            uint entry = index;
            for (int bit = 0; bit < 8; bit++) entry = (entry & 1) != 0 ? 0xedb88320 ^ (entry >> 1) : entry >> 1;
            table[index] = entry;
        }
        return table;
    }

    public void Append(ReadOnlySpan<byte> data)
    {
        uint crc = value;
        foreach (byte b in data) crc = Table[(crc ^ b) & 0xff] ^ (crc >> 8);
        value = crc;
    }

    public void Append(byte[] data) => Append(data.AsSpan());

    public uint GetCurrentHashAsUInt32() => value ^ 0xffffffff;

    public static uint HashToUInt32(ReadOnlySpan<byte> data)
    {
        var crc = new Crc32();
        crc.Append(data);
        return crc.GetCurrentHashAsUInt32();
    }
}
