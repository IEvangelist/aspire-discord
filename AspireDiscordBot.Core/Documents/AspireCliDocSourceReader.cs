using System.Runtime.CompilerServices;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Reads the published Aspire documentation via the <c>aspire docs</c> CLI — the authoritative
/// source of truth — instead of scraping repository <c>.mdx</c> files. It lists pages with
/// <c>aspire docs list</c>, fetches each page's markdown with <c>aspire docs get</c> (bounded
/// concurrency), and resolves clickable citation URLs from the aspire.dev sitemap.
/// </summary>
public sealed class AspireCliDocSourceReader(
    AspireDocUrlIndex urlIndex,
    IOptions<IngestionOptions> options,
    ILogger<AspireCliDocSourceReader> logger) : IDocSourceReader
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly AspireCliOptions _cli = options.Value.Cli;

    public string ModeName => "cli";

    // The DocRepoOptions list is ignored in CLI mode; the CLI itself is the source.
    public async IAsyncEnumerable<RawDocument> ReadAllAsync(
        IReadOnlyList<DocRepoOptions> sources,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var timeout = TimeSpan.FromSeconds(Math.Max(10, _cli.CommandTimeoutSeconds));

        var pages = await ListPagesAsync(timeout, cancellationToken);
        if (pages.Count == 0)
        {
            logger.LogWarning("`aspire docs list` returned no pages; nothing to ingest via the CLI.");
            yield break;
        }

        logger.LogInformation("Aspire CLI: {Count} documentation pages to ingest.", pages.Count);

        // Build the title -> canonical-URL index so each page can be cited with an exact deep link.
        if (_cli.ResolveDeepLinks)
        {
            await urlIndex.LoadAsync(cancellationToken);
        }

        // Fan out `aspire docs get` calls with bounded concurrency, streaming results as they arrive.
        var channel = Channel.CreateBounded<RawDocument>(new BoundedChannelOptions(_cli.MaxConcurrency * 2)
        {
            SingleReader = true,
            SingleWriter = false,
        });
        var failures = new ConcurrentQueue<string>();

        var producer = Task.Run(async () =>
        {
            using var throttle = new SemaphoreSlim(Math.Max(1, _cli.MaxConcurrency));
            var tasks = pages.Select(async page =>
            {
                await throttle.WaitAsync(cancellationToken);
                try
                {
                    var content = await GetPageContentAsync(page.Slug, timeout, cancellationToken);
                    if (string.IsNullOrWhiteSpace(content))
                    {
                        return;
                    }

                    var url = _cli.ResolveDeepLinks
                        ? urlIndex.Resolve(page.Title)
                        : $"{_cli.SiteBaseUrl.TrimEnd('/')}/?q={Uri.EscapeDataString(page.Title)}";

                    await channel.Writer.WriteAsync(new RawDocument(
                        _cli.RepoLabel, page.Slug, content, "resolved", "main")
                    {
                        Title = page.Title,
                        ResolvedUrl = url,
                    }, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Failed to fetch Aspire docs page '{Slug}'.", page.Slug);
                    failures.Enqueue($"{page.Slug}: {ex.Message}");
                }
                finally
                {
                    throttle.Release();
                }
            });

            try
            {
                await Task.WhenAll(tasks);
            }
            finally
            {
                channel.Writer.Complete();
            }
        }, cancellationToken);

        await foreach (var doc in channel.Reader.ReadAllAsync(cancellationToken))
        {
            yield return doc;
        }

        await producer;
        if (!failures.IsEmpty)
        {
            throw new InvalidOperationException(
                $"{failures.Count} Aspire documentation pages failed to load; "
                + "the current index was preserved. First failure: "
                + failures.TryPeek(out var first) switch
                {
                    true => first,
                    false => "unknown",
                });
        }
    }

    private async Task<List<DocListItem>> ListPagesAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var result = await ProcessRunner.RunAsync(
            _cli.Executable,
            ["docs", "list", "--format", "Json", "--non-interactive"],
            timeout,
            cancellationToken);

        if (result.ExitCode != 0)
        {
            logger.LogError("`aspire docs list` failed (exit {Exit}): {Error}", result.ExitCode, result.StandardError);
            return [];
        }

        var items = ParseJson<List<DocListItem>>(result.StandardOutput) ?? [];

        // Drop the synthetic 404 page and any empty slugs.
        return items
            .Where(i => !string.IsNullOrWhiteSpace(i.Slug) && !string.Equals(i.Slug, "404", StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    private async Task<string?> GetPageContentAsync(string slug, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var result = await ProcessRunner.RunAsync(
            _cli.Executable,
            ["docs", "get", slug, "--format", "Json", "--non-interactive"],
            timeout,
            cancellationToken);

        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"`aspire docs get {slug}` failed (exit {result.ExitCode}): {result.StandardError}");
        }

        var page = ParseJson<DocPage>(result.StandardOutput);
        return page?.Content
            ?? throw new InvalidOperationException($"`aspire docs get {slug}` returned invalid JSON.");
    }

    /// <summary>
    /// Extracts the JSON payload from CLI output, tolerating any leading banner/status text
    /// (e.g. "Loading documentation...") the CLI may print before the JSON.
    /// </summary>
    private static T? ParseJson<T>(string output)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return default;
        }

        var arrayStart = output.IndexOf('[');
        var objectStart = output.IndexOf('{');
        var start = (arrayStart, objectStart) switch
        {
            ( < 0, < 0) => -1,
            ( < 0, _) => objectStart,
            (_, < 0) => arrayStart,
            _ => Math.Min(arrayStart, objectStart),
        };

        if (start < 0)
        {
            return default;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(output[start..], JsonOptions);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private sealed class DocListItem
    {
        [JsonPropertyName("title")] public string Title { get; set; } = "";
        [JsonPropertyName("slug")] public string Slug { get; set; } = "";
        [JsonPropertyName("summary")] public string Summary { get; set; } = "";
    }

    private sealed class DocPage
    {
        [JsonPropertyName("title")] public string Title { get; set; } = "";
        [JsonPropertyName("slug")] public string Slug { get; set; } = "";
        [JsonPropertyName("content")] public string Content { get; set; } = "";
    }
}
