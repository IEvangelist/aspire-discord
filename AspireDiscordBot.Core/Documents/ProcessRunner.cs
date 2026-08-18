using System.Diagnostics;
using System.Text;

namespace AspireDiscordBot.Core.Documents;

/// <summary>The captured result of running a console process.</summary>
public readonly record struct ProcessResult(int ExitCode, string StandardOutput, string StandardError);

/// <summary>Runs a console process and captures its output, with a timeout.</summary>
public static class ProcessRunner
{
    public static async Task<ProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            },
        };

        foreach (var arg in arguments)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

        SanitizeEnvironment(process.StartInfo);

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        if (!process.Start())
        {
            throw new InvalidOperationException($"Failed to start process '{fileName}'.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(timeout);

        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            throw new TimeoutException($"Process '{fileName}' timed out after {timeout.TotalSeconds:N0}s.");
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw;
        }

        return new ProcessResult(process.ExitCode, stdout.ToString(), stderr.ToString());
    }

    /// <summary>
    /// Removes environment variables that would make a spawned <c>aspire</c> CLI child think it is
    /// running inside the current <c>aspire run</c> session or the VS Code extension. Without this,
    /// each <c>aspire docs</c> invocation connects to the running AppHost's auxiliary backchannel /
    /// extension — routing its output to the editor as a notification and churning the backchannel
    /// connection (seen as the dashboard "rejoining the server…" and instability). Stripping these
    /// makes the CLI run as a clean, standalone command.
    /// </summary>
    private static void SanitizeEnvironment(ProcessStartInfo startInfo)
    {
        var toRemove = startInfo.Environment.Keys
            .Where(key =>
                key.StartsWith("ASPIRE_EXTENSION_", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("ASPIRE_LAUNCHER_", StringComparison.OrdinalIgnoreCase)
                || key.Equals("ASPIRE_CLI_PID", StringComparison.OrdinalIgnoreCase)
                || key.Equals("ASPIRE_CLI_STARTED_BY_EXTENSION", StringComparison.OrdinalIgnoreCase)
                || key.Equals("DEBUG_SESSION_PORT", StringComparison.OrdinalIgnoreCase)
                || key.Equals("DOTNET_LAUNCH_PROFILE", StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (var key in toRemove)
        {
            startInfo.Environment.Remove(key);
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort.
        }
    }
}
