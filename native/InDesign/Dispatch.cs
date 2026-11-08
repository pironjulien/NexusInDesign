using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;

namespace NexusInDesign.InDesign;

/// <summary>
/// IDispatch, the late-bound automation interface InDesign's COM server exposes, with its interop code generated at
/// compile time (ComWrappers): Native AOT has no built-in COM interop, no <c>dynamic</c> and no Type.InvokeMember.
/// </summary>
[GeneratedComInterface]
[Guid("00020400-0000-0000-C000-000000000046")]
internal unsafe partial interface IDispatch
{
    [PreserveSig] int GetTypeInfoCount(uint* count);

    [PreserveSig] int GetTypeInfo(uint index, uint lcid, nint* typeInfo);

    [PreserveSig] int GetIDsOfNames(Guid* riid, char** names, uint count, uint lcid, int* dispIds);

    [PreserveSig] int Invoke(int dispId, Guid* riid, uint lcid, ushort flags, DispParams* parameters, Variant* result, ExcepInfo* exception, uint* argumentError);
}

/// <summary>A failed automation call: the COM error code and the description the server gave (EXCEPINFO).</summary>
internal sealed class AutomationException(string message, int errorCode) : COMException(message, errorCode);

/// <summary>VARIANT (24 bytes on 64-bit Windows, the only release architectures: x64 and arm64).</summary>
[StructLayout(LayoutKind.Explicit, Size = 24)]
internal struct Variant
{
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public long Int64;
    [FieldOffset(8)] public int Int32;
    [FieldOffset(8)] public short Int16;
    [FieldOffset(8)] public byte Byte;
    [FieldOffset(8)] public double Double;
    [FieldOffset(8)] public float Single;
    [FieldOffset(8)] public nint Pointer;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DispParams
{
    public Variant* Arguments;
    public int* NamedArguments;
    public uint ArgumentCount;
    public uint NamedArgumentCount;
}

[StructLayout(LayoutKind.Sequential)]
internal struct ExcepInfo
{
    public ushort Code;
    public ushort Reserved;
    public nint Source;
    public nint Description;
    public nint HelpFile;
    public uint HelpContext;
    public nint Reserved2;
    public nint DeferredFillIn;
    public int SCode;
}

/// <summary>
/// One COM automation object reached through IDispatch: methods and properties by name, arguments and results as
/// VARIANTs (string, integers, double, bool, nested objects). Used only on the STA thread that created it. Dispose
/// releases the COM reference at once, as Marshal.FinalReleaseComObject did.
/// </summary>
internal sealed unsafe partial class DispatchObject : IDisposable
{
    private const ushort VtEmpty = 0, VtNull = 1, VtI2 = 2, VtI4 = 3, VtR4 = 4, VtR8 = 5, VtBstr = 8, VtDispatch = 9, VtBool = 11,
        VtI1 = 16, VtUi1 = 17, VtUi2 = 18, VtUi4 = 19, VtI8 = 20, VtUi8 = 21, VtInt = 22, VtUint = 23;
    private const ushort DispatchMethod = 1, DispatchPropertyGet = 2;
    private const int DispatchException = unchecked((int)0x80020009);
    private const uint ServerContexts = 0x17; // CLSCTX_SERVER: in-process, local and remote servers, as Activator.CreateInstance
    private static readonly Guid DispatchId = new("00020400-0000-0000-C000-000000000046");
    private static readonly StrategyBasedComWrappers Wrappers = new();

    private readonly IDispatch dispatch;
    private readonly Dictionary<string, int> ids = new(StringComparer.OrdinalIgnoreCase);
    private bool disposed;

    private DispatchObject(nint unknown)
    {
        // A unique wrapper per object, so Dispose releases exactly this reference (no cached, shared RCW).
        dispatch = (IDispatch)Wrappers.GetOrCreateObjectForComInstance(unknown, CreateObjectFlags.UniqueInstance);
    }

    /// <summary>Starts (or attaches to) the COM server registered under the ProgID; null when the ProgID is not registered.</summary>
    public static DispatchObject? Create(string progId)
    {
        Guid clsid;
        if (CLSIDFromProgID(progId, &clsid) < 0) return null;
        Guid iid = DispatchId;
        nint unknown;
        Marshal.ThrowExceptionForHR(CoCreateInstance(&clsid, 0, ServerContexts, &iid, &unknown));
        try { return new DispatchObject(unknown); }
        finally { Marshal.Release(unknown); }
    }

    /// <summary>
    /// Calls a method, or reads a property with arguments, as VBScript does; returns its result (string, number, bool,
    /// DispatchObject to dispose, or null).
    /// </summary>
    public object? Invoke(string method, params object?[] arguments) => Call(method, DispatchMethod | DispatchPropertyGet, arguments);

    /// <summary>Reads a property.</summary>
    public object? Get(string property) => Call(property, DispatchPropertyGet, []);

    private object? Call(string name, ushort flags, object?[] arguments)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        int dispId = Id(name);
        int count = arguments.Length;
        Variant* values = stackalloc Variant[Math.Max(count, 1)];
        // IDispatch takes its arguments last first.
        for (int index = 0; index < count; index++) values[count - 1 - index] = ToVariant(arguments[index]);
        Variant result = default;
        ExcepInfo exception = default;
        uint argumentError = 0;
        try
        {
            var parameters = new DispParams { Arguments = values, ArgumentCount = (uint)count };
            Guid none = Guid.Empty;
            int hr = dispatch.Invoke(dispId, &none, 0, flags, &parameters, &result, &exception, &argumentError);
            if (hr == DispatchException) throw FromExcepInfo(name, ref exception);
            if (hr < 0) throw new AutomationException($"{name}: {Marshal.GetExceptionForHR(hr)?.Message}", hr);
            return FromVariant(ref result);
        }
        finally
        {
            for (int index = 0; index < count; index++) _ = VariantClear(&values[index]);
            _ = VariantClear(&result);
        }
    }

    private int Id(string name)
    {
        if (ids.TryGetValue(name, out int cached)) return cached;
        int id;
        fixed (char* text = name)
        {
            char* names = text;
            Guid none = Guid.Empty;
            int hr = dispatch.GetIDsOfNames(&none, &names, 1, 0, &id);
            if (hr < 0) throw new AutomationException($"Unknown member {name}.", hr);
        }
        ids[name] = id;
        return id;
    }

    private static Variant ToVariant(object? value)
    {
        var variant = new Variant();
        switch (value)
        {
            case null: variant.Type = VtEmpty; break;
            case string text: variant.Type = VtBstr; variant.Pointer = Marshal.StringToBSTR(text); break;
            case int number: variant.Type = VtI4; variant.Int32 = number; break;
            case long number: variant.Type = VtI8; variant.Int64 = number; break;
            case double number: variant.Type = VtR8; variant.Double = number; break;
            case bool flag: variant.Type = VtBool; variant.Int16 = flag ? (short)-1 : (short)0; break;
            default: throw new ArgumentException($"No VARIANT for {value.GetType().Name}.", nameof(value));
        }
        return variant;
    }

    private static object? FromVariant(ref Variant variant) => variant.Type switch
    {
        VtEmpty or VtNull => null,
        VtI2 => variant.Int16,
        VtI4 or VtInt => variant.Int32,
        VtR4 => variant.Single,
        VtR8 => variant.Double,
        VtBstr => variant.Pointer == 0 ? "" : Marshal.PtrToStringBSTR(variant.Pointer),
        VtDispatch => variant.Pointer == 0 ? null : new DispatchObject(variant.Pointer),
        VtBool => variant.Int16 != 0,
        VtI1 => (sbyte)variant.Byte,
        VtUi1 => variant.Byte,
        VtUi2 => (ushort)variant.Int16,
        VtUi4 or VtUint => (uint)variant.Int32,
        VtI8 => variant.Int64,
        VtUi8 => (ulong)variant.Int64,
        _ => AsText(ref variant),
    };

    /// <summary>Any other VARIANT (date, currency, decimal…) as the text COM itself gives it.</summary>
    private static string? AsText(ref Variant variant)
    {
        Variant text = default;
        fixed (Variant* source = &variant)
        {
            if (VariantChangeTypeEx(&text, source, (uint)CultureInfo.CurrentCulture.LCID, 0, VtBstr) < 0) return null;
        }
        try { return text.Pointer == 0 ? "" : Marshal.PtrToStringBSTR(text.Pointer); }
        finally { _ = VariantClear(&text); }
    }

    private static AutomationException FromExcepInfo(string name, ref ExcepInfo info)
    {
        if (info.DeferredFillIn != 0)
        {
            fixed (ExcepInfo* pointer = &info) ((delegate* unmanaged[Stdcall]<ExcepInfo*, int>)info.DeferredFillIn)(pointer);
        }
        string? description = info.Description == 0 ? null : Marshal.PtrToStringBSTR(info.Description);
        foreach (nint text in new[] { info.Source, info.Description, info.HelpFile }) if (text != 0) Marshal.FreeBSTR(text);
        int code = info.SCode != 0 ? info.SCode : info.Code != 0 ? info.Code : DispatchException;
        return new AutomationException(string.IsNullOrWhiteSpace(description) ? $"{name} failed (0x{code:X8})." : description, code);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        ((ComObject)(object)dispatch).FinalRelease();
    }

    [LibraryImport("ole32.dll")] private static partial int CLSIDFromProgID([MarshalAs(UnmanagedType.LPWStr)] string progId, Guid* clsid);
    [LibraryImport("ole32.dll")] private static partial int CoCreateInstance(Guid* clsid, nint outer, uint context, Guid* iid, nint* instance);
    [LibraryImport("oleaut32.dll")] private static partial int VariantClear(Variant* variant);
    [LibraryImport("oleaut32.dll")] private static partial int VariantChangeTypeEx(Variant* destination, Variant* source, uint lcid, ushort flags, ushort type);
}
