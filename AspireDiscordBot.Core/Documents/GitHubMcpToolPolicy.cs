using System.Text.RegularExpressions;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>Constrains every GitHub MCP invocation to configured repositories.</summary>
public sealed partial class GitHubMcpToolPolicy(IOptions<GitHubMcpOptions> options)
{
    private readonly GitHubMcpOptions _options = options.Value;

    public IReadOnlyDictionary<string, object?> Constrain(
        string toolName,
        AIFunctionArguments arguments,
        System.Text.Json.JsonElement schema)
    {
        if (_options.AllowedRepositories.Count == 0)
        {
            throw new InvalidOperationException("GitHubMcp:AllowedRepositories must contain at least one repository.");
        }

        var allowed = _options.AllowedRepositories
            .Select(NormalizeRepository)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var defaultRepository = allowed.First();
        var separator = defaultRepository.IndexOf('/');
        var defaultOwner = defaultRepository[..separator];
        var defaultName = defaultRepository[(separator + 1)..];

        var constrained = arguments.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var properties = schema.TryGetProperty("properties", out var schemaProperties)
            && schemaProperties.ValueKind is System.Text.Json.JsonValueKind.Object
                ? schemaProperties
                : default;

        var ownerKey = FindKey(constrained, "owner") ?? SchemaKey(properties, "owner");
        var repoKey = FindKey(constrained, "repo") ?? SchemaKey(properties, "repo");
        var repositoryKey = FindKey(constrained, "repository") ?? SchemaKey(properties, "repository");

        if (ownerKey is not null && !constrained.ContainsKey(ownerKey))
        {
            constrained[ownerKey] = defaultOwner;
        }

        if (repoKey is not null && !constrained.ContainsKey(repoKey))
        {
            constrained[repoKey] = defaultName;
        }

        if (repositoryKey is not null && !constrained.ContainsKey(repositoryKey))
        {
            constrained[repositoryKey] = defaultRepository;
        }

        var owner = ReadString(constrained, ownerKey);
        var repo = ReadString(constrained, repoKey);
        var repository = ReadString(constrained, repositoryKey);

        if (!string.IsNullOrWhiteSpace(repository))
        {
            EnsureAllowed(repository!, allowed);
        }

        if (!string.IsNullOrWhiteSpace(repo))
        {
            var qualified = repo!.Contains('/')
                ? repo
                : $"{owner ?? defaultOwner}/{repo}";
            EnsureAllowed(qualified, allowed);
        }

        var queryKey = FindKey(constrained, "query");
        if (queryKey is not null && constrained[queryKey] is string query && IsSearchTool(toolName))
        {
            if (BooleanBranchRegex().IsMatch(query)
                || DisallowedScopeRegex().IsMatch(query))
            {
                throw new InvalidOperationException(
                    "GitHub search queries may not contain Boolean branches or organization/user scopes.");
            }

            var qualifiers = RepositoryQualifierRegex().Matches(query)
                .Select(match => match.Groups["repo"].Value.Trim('"', '\''))
                .ToArray();
            foreach (var qualifier in qualifiers)
            {
                EnsureAllowed(qualifier, allowed);
            }

            if (qualifiers.Length == 0)
            {
                constrained[queryKey] = $"{query.Trim()} repo:{defaultRepository}";
            }
        }

        return constrained;
    }

    public bool IsAllowedUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var path = uri.AbsolutePath.Trim('/');
        string? repository = uri.Host.ToLowerInvariant() switch
        {
            "github.com" when path.Split('/').Length >= 2 =>
                string.Join('/', path.Split('/').Take(2)),
            "api.github.com" when path.StartsWith("repos/", StringComparison.OrdinalIgnoreCase)
                && path.Split('/').Length >= 3 =>
                string.Join('/', path.Split('/').Skip(1).Take(2)),
            _ => null,
        };

        return repository is not null
            && _options.AllowedRepositories.Any(allowed =>
                string.Equals(NormalizeRepository(allowed), repository, StringComparison.OrdinalIgnoreCase));
    }

    private static string? FindKey(IReadOnlyDictionary<string, object?> arguments, string expected) =>
        arguments.Keys.FirstOrDefault(key => string.Equals(key, expected, StringComparison.OrdinalIgnoreCase));

    private static string? SchemaKey(System.Text.Json.JsonElement properties, string expected)
    {
        if (properties.ValueKind is not System.Text.Json.JsonValueKind.Object)
        {
            return null;
        }

        foreach (var property in properties.EnumerateObject())
        {
            if (string.Equals(property.Name, expected, StringComparison.OrdinalIgnoreCase))
            {
                return property.Name;
            }
        }

        return null;
    }

    private static string? ReadString(
        IReadOnlyDictionary<string, object?> arguments,
        string? key) =>
        key is not null && arguments.TryGetValue(key, out var value) ? value?.ToString() : null;

    private static bool IsSearchTool(string name) =>
        name.StartsWith("search_", StringComparison.OrdinalIgnoreCase);

    private static void EnsureAllowed(string repository, IReadOnlySet<string> allowed)
    {
        repository = NormalizeRepository(repository);
        if (!allowed.Contains(repository))
        {
            throw new InvalidOperationException(
                $"GitHub MCP access to '{repository}' is not allowed. Allowed repositories: "
                + string.Join(", ", allowed.Order(StringComparer.OrdinalIgnoreCase)));
        }
    }

    private static string NormalizeRepository(string repository) =>
        repository.Trim().Trim('/').Replace('\\', '/');

    [GeneratedRegex(@"(?:^|\s)repo:(?<repo>[""']?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+[""']?)", RegexOptions.IgnoreCase)]
    private static partial Regex RepositoryQualifierRegex();

    [GeneratedRegex(@"\b(?:OR|NOT)\b|\|")]
    private static partial Regex BooleanBranchRegex();

    [GeneratedRegex(@"(?:^|\s)(?:org|user|owner):", RegexOptions.IgnoreCase)]
    private static partial Regex DisallowedScopeRegex();
}
