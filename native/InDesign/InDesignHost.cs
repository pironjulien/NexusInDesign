using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace NexusInDesign.InDesign;

internal enum ScriptLanguage { Uxp, ExtendScript }

/// <summary>One script handed to InDesign. Template and Inputs describe it (audit, tests); ScriptPath holds the source.</summary>
internal sealed record ScriptRun(
    string Template,
    ScriptLanguage Language,
    string ScriptPath,
    string? CompletionPath,
    TimeSpan Timeout,
    JsonObject Inputs)
{
    /// <summary>Checked once the cross-process mutex is held, right before DoScript (durable lease, etc.).</summary>
    public Action? Guard { get; init; }

    /// <summary>The operation hold (from HoldAsync) this script runs inside, if any.</summary>
    public IAsyncDisposable? Hold { get; init; }
}

internal sealed record HostProcess(int ProcessId, DateTime StartedAtUtc, bool? Visible);

/// <summary>InDesign as the engine sees it: scripts run under the shared automation mutex, and its processes.</summary>
internal interface IInDesignHost
{
    /// <summary>Runs one script; returns DoScript's value (synchronous UXP setResult or ExtendScript return).</summary>
    Task<string?> RunAsync(ScriptRun run);

    /// <summary>Holds the cross-process automation mutex for a whole operation (all its scripts run inside).</summary>
    Task<IAsyncDisposable> HoldAsync(string operationId);

    IReadOnlyList<HostProcess> Processes();
}

/// <summary>
/// InDesign through its COM automation server, in this process: no PowerShell, no panel, no network. Every call runs on
/// one STA thread that owns the named mutex Local\NexusInDesignAutomation (shared with every NexusInDesign tool on this
/// session), so a Windows mutex, which belongs to a thread, is acquired and released by the same thread. A call that
/// exceeds its delay leaves its thread to finish (and release the mutex) on its own; the next call gets a new thread.
/// </summary>
internal sealed class ComInDesignHost : IInDesignHost, IDisposable
{
    public const string MutexName = @"Local\NexusInDesignAutomation";
    private const int UxpLanguage = 1431522407;       // ScriptLanguage.UXPSCRIPT
    private const int JavaScriptLanguage = 1246973031; // ScriptLanguage.JAVASCRIPT
    private static readonly string[] ProgIds = ["InDesign.Application.2026", "InDesign.Application.2025", "InDesign.Application.2024"];
    private static readonly TimeSpan MutexWait = TimeSpan.FromMinutes(2);

    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly object workerLock = new();
    private readonly string mutexName;
    private Worker? worker;

    public ComInDesignHost(string mutexName = MutexName) => this.mutexName = mutexName;

    public IReadOnlyList<HostProcess> Processes() => SnapshotProcesses();

    internal static IReadOnlyList<HostProcess> SnapshotProcesses()
    {
        var list = new List<HostProcess>();
        foreach (var process in Process.GetProcessesByName("InDesign"))
        {
            using (process)
            {
                try
                {
                    bool? visible = null;
                    try { visible = process.MainWindowHandle != IntPtr.Zero; } catch (InvalidOperationException) { }
                    list.Add(new HostProcess(process.Id, process.StartTime.ToUniversalTime(), visible));
                }
                catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            }
        }
        return list.OrderBy(entry => entry.ProcessId).ToList();
    }

    public async Task<IAsyncDisposable> HoldAsync(string operationId)
    {
        await gate.WaitAsync().ConfigureAwait(false);
        var owner = GetWorker();
        try
        {
            await owner.Post(() => { owner.AcquireMutex(mutexName); return null; }, MutexWait + TimeSpan.FromSeconds(10)).ConfigureAwait(false);
        }
        catch
        {
            gate.Release();
            throw;
        }
        return new Hold(this, owner, operationId);
    }

    public async Task<string?> RunAsync(ScriptRun run)
    {
        if (run.Hold is Hold hold && !hold.Disposed)
        {
            if (hold.Owner.Poisoned)
                throw new ToolError("INDESIGN_CALL_STUCK", "Un appel InDesign précédent de cette opération ne s’est pas terminé ; l’issue doit être vérifiée.", true);
            return await Execute(hold.Owner, run, mutexHeld: true).ConfigureAwait(false);
        }
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            return await Execute(GetWorker(), run, mutexHeld: false).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<string?> Execute(Worker owner, ScriptRun run, bool mutexHeld)
    {
        // Synchronous scripts block DoScript; asynchronous ones also wait for their result file and quiescence.
        TimeSpan budget = run.CompletionPath is null ? run.Timeout : (run.Timeout * 2) + TimeSpan.FromSeconds(5);
        if (!mutexHeld) budget += MutexWait;
        try
        {
            return (string?)await owner.Post(() =>
            {
                bool acquired = false;
                if (!mutexHeld) { owner.AcquireMutex(mutexName); acquired = true; }
                try
                {
                    run.Guard?.Invoke();
                    return RunOnStaThread(run);
                }
                finally
                {
                    if (acquired) owner.ReleaseMutex();
                }
            }, budget).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            Poison(owner);
            throw run.CompletionPath is null
                ? new ToolError("COM_TIMEOUT_OUTCOME_UNKNOWN", "InDesign n’a pas terminé l’appel COM dans le délai ; l’issue peut être indéterminée.", true)
                : new ToolError("UXP_OUTCOME_UNKNOWN", "Le délai UXP est dépassé ; l’issue peut être indéterminée. Inspectez le document avant toute nouvelle action.", true);
        }
    }

    private static string? RunOnStaThread(ScriptRun run)
    {
        var before = SnapshotProcesses();
        object? application = null;
        bool outcomeKnown = false;
        Exception? operationError = null;
        string? result = null;
        try
        {
            application = CreateApplication();
            string payload = run.Language == ScriptLanguage.Uxp ? run.ScriptPath : File.ReadAllText(run.ScriptPath);
            object? value = Invoke(application, "DoScript", payload, run.Language == ScriptLanguage.Uxp ? UxpLanguage : JavaScriptLanguage);
            result = value?.ToString();
            if (run.CompletionPath is not null) WaitForCompletion(application, run.CompletionPath, run.Timeout);
            outcomeKnown = true;
        }
        catch (Exception exception)
        {
            operationError = exception is TargetInvocationException { InnerException: { } inner } ? inner : exception;
        }
        try
        {
            if (application is not null) DisposeHost(application, before, outcomeKnown);
        }
        catch (Exception lifecycle) when (operationError is null)
        {
            operationError = lifecycle;
        }
        finally
        {
            if (application is not null && Marshal.IsComObject(application)) Marshal.FinalReleaseComObject(application);
        }
        if (operationError is ToolError) throw operationError;
        if (operationError is not null)
        {
            bool unknown = run.CompletionPath is not null || outcomeKnown;
            throw new ToolError(run.CompletionPath is not null ? "UXP_OUTCOME_UNKNOWN" : "INDESIGN_COM_FAILED",
                $"L’appel COM InDesign a échoué : {operationError.Message}", unknown, operationError);
        }
        return result;
    }

    private static object CreateApplication()
    {
        Exception? last = null;
        foreach (string progId in ProgIds)
        {
            var type = Type.GetTypeFromProgID(progId, throwOnError: false);
            if (type is null) continue;
            try { return Activator.CreateInstance(type) ?? throw new InvalidOperationException(progId); }
            catch (Exception exception) { last = exception; }
        }
        throw new ToolError("INDESIGN_NOT_REGISTERED",
            $"Aucune version InDesign compatible (2024 à 2026) n’est enregistrée pour COM.{(last is null ? "" : " " + last.Message)}");
    }

    internal static object? Invoke(object target, string method, params object[] args) =>
        target.GetType().InvokeMember(method, BindingFlags.InvokeMethod, null, target, args, System.Globalization.CultureInfo.InvariantCulture);

    private static object? Get(object target, string property) =>
        target.GetType().InvokeMember(property, BindingFlags.GetProperty, null, target, null, System.Globalization.CultureInfo.InvariantCulture);

    private static void WaitForCompletion(object application, string completionPath, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            if (File.Exists(completionPath))
            {
                try
                {
                    string raw = File.ReadAllText(completionPath);
                    if (raw.Length > 0) { JsonNode.Parse(raw); break; }
                }
                catch (Exception exception) when (exception is IOException or System.Text.Json.JsonException) { }
            }
            if (DateTime.UtcNow >= deadline)
                throw new ToolError("UXP_OUTCOME_UNKNOWN", "Le délai du résultat UXP asynchrone est dépassé ; issue indéterminée.", true);
            Thread.Sleep(25);
        }
        var quiet = DateTime.UtcNow + TimeSpan.FromMilliseconds(Math.Min(timeout.TotalMilliseconds, 30_000));
        while (true)
        {
            bool modal;
            try { modal = Convert.ToBoolean(Get(application, "ModalState"), System.Globalization.CultureInfo.InvariantCulture); }
            catch (Exception exception) when (exception is COMException or TargetInvocationException) { modal = true; }
            if (!modal) return;
            if (DateTime.UtcNow >= quiet)
                throw new ToolError("UXP_OUTCOME_UNKNOWN", "InDesign reste en état modal après le résultat UXP ; issue indéterminée.", true);
            Thread.Sleep(25);
        }
    }

    /// <summary>
    /// An InDesign this call started itself (none ran before, exactly one now), still hidden, with no document and no
    /// dialog once the outcome is known, is closed again; a hidden InDesign that keeps documents is shown; a visible one
    /// is left as it is. Nothing is ever killed.
    /// </summary>
    private static void DisposeHost(object application, IReadOnlyList<HostProcess> before, bool outcomeKnown)
    {
        var after = SnapshotProcesses();
        var created = after.Where(process => !before.Any(old => old.ProcessId == process.ProcessId && old.StartedAtUtc == process.StartedAtUtc)).ToList();
        HostProcess? target = created.Count == 1 ? created[0] : after.Count == 1 ? after[0] : null;
        if (target is null || target.Visible != false) return;
        bool owned = before.Count == 0 && created.Count == 1;
        int? documents = null;
        bool modal = true;
        try
        {
            object? collection = Get(application, "Documents");
            if (collection is not null)
            {
                documents = Convert.ToInt32(Get(collection, "Count"), System.Globalization.CultureInfo.InvariantCulture);
                if (Marshal.IsComObject(collection)) Marshal.FinalReleaseComObject(collection);
            }
            modal = Convert.ToBoolean(Get(application, "ModalState"), System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception exception) when (exception is COMException or TargetInvocationException) { }
        if (owned && outcomeKnown && documents == 0 && !modal)
        {
            try { Invoke(application, "Quit"); }
            catch (Exception exception) when (exception is COMException or TargetInvocationException)
            {
                throw new ToolError("INDESIGN_HOST_QUIT_FAILED", "InDesign n’a pas accepté la fermeture de son hôte COM.", false, exception);
            }
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (DateTime.UtcNow < deadline)
            {
                if (!SnapshotProcesses().Any(process => process.ProcessId == target.ProcessId && process.StartedAtUtc == target.StartedAtUtc)) return;
                Thread.Sleep(50);
            }
            throw new ToolError("INDESIGN_HOST_EXIT_UNCONFIRMED", "Le processus InDesign créé par cet appel reste actif ; aucune terminaison forcée n’a été tentée.");
        }
        try { Invoke(application, "Activate"); }
        catch (Exception exception) when (exception is COMException or TargetInvocationException)
        {
            throw new ToolError("INDESIGN_HOST_ACTIVATION_FAILED", "InDesign n’a pas accepté son activation visible.", false, exception);
        }
    }

    private Worker GetWorker()
    {
        lock (workerLock)
        {
            if (worker is null || worker.Poisoned) worker = new Worker();
            return worker;
        }
    }

    private void Poison(Worker owner)
    {
        lock (workerLock)
        {
            owner.Poison();
            if (ReferenceEquals(worker, owner)) worker = null;
        }
    }

    public void Dispose()
    {
        lock (workerLock) { worker?.Stop(); worker = null; }
        gate.Dispose();
    }

    private sealed class Hold(ComInDesignHost host, Worker owner, string operationId) : IAsyncDisposable
    {
        public Worker Owner { get; } = owner;
        public string OperationId { get; } = operationId;
        public bool Disposed { get; private set; }

        public async ValueTask DisposeAsync()
        {
            if (Disposed) return;
            Disposed = true;
            try
            {
                if (Owner.Poisoned) Owner.ReleaseWhenDone();
                else await Owner.Post(() => { Owner.ReleaseMutex(); return null; }, TimeSpan.FromSeconds(30)).ConfigureAwait(false);
            }
            finally
            {
                host.gate.Release();
            }
        }
    }

    /// <summary>One STA thread, its queue and the mutex it owns.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA1001", Justification = "The STA thread owns the queue: Stop completes it and the thread drains it; disposing it from another thread would race the consumer.")]
    private sealed class Worker
    {
        private readonly System.Collections.Concurrent.BlockingCollection<Action> queue = new();
        private readonly Thread thread;
        private Mutex? mutex;
        private bool owned;
        private volatile bool releaseWhenDone;

        public Worker()
        {
            thread = new Thread(Loop) { IsBackground = true, Name = "NexusInDesign COM" };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }

        public bool Poisoned { get; private set; }

        public void Poison()
        {
            Poisoned = true;
            releaseWhenDone = true;
            queue.CompleteAdding();
        }

        public void ReleaseWhenDone() => releaseWhenDone = true;

        public void Stop() => queue.CompleteAdding();

        public Task<object?> Post(Func<object?> work, TimeSpan budget)
        {
            var completion = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
            try
            {
                queue.Add(() =>
                {
                    try { completion.TrySetResult(work()); }
                    catch (Exception exception) { completion.TrySetException(exception); }
                });
            }
            catch (InvalidOperationException)
            {
                throw new ToolError("INDESIGN_CALL_STUCK", "Le fil d’exécution InDesign est arrêté après un appel resté sans réponse.", true);
            }
            return WithBudget(completion.Task, budget);
        }

        private static async Task<object?> WithBudget(Task<object?> task, TimeSpan budget)
        {
            if (await Task.WhenAny(task, Task.Delay(budget)).ConfigureAwait(false) != task) throw new TimeoutException();
            return await task.ConfigureAwait(false);
        }

        public void AcquireMutex(string name)
        {
            if (owned) return;
            mutex ??= new Mutex(false, name);
            bool acquired;
            try
            {
                acquired = mutex.WaitOne(MutexWait);
            }
            catch (AbandonedMutexException)
            {
                // The previous holder ended without releasing it: its InDesign outcome is unknown. The mutex is now
                // ours; release it and refuse, so the caller checks before going on.
                mutex.ReleaseMutex();
                throw new ToolError("INDESIGN_MUTEX_ABANDONED", "Le mutex commun InDesign a été abandonné ; la commande précédente doit être vérifiée avant de recommencer.", true);
            }
            if (!acquired) throw new ToolError("INDESIGN_QUEUE_TIMEOUT", "Le délai de la file InDesign inter-processus est dépassé (une autre commande InDesign est en cours).");
            owned = true;
        }

        public void ReleaseMutex()
        {
            if (!owned || mutex is null) return;
            owned = false;
            mutex.ReleaseMutex();
        }

        private void Loop()
        {
            try
            {
                foreach (var action in queue.GetConsumingEnumerable())
                {
                    action();
                    if (releaseWhenDone && Poisoned) break;
                }
            }
            finally
            {
                if (releaseWhenDone || queue.IsAddingCompleted) ReleaseMutex();
                mutex?.Dispose();
            }
        }
    }
}
