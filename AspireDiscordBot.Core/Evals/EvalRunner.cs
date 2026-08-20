using System.Diagnostics;
using AspireDiscordBot.Core.Rag;

namespace AspireDiscordBot.Core.Evals;

/// <summary>The result of checking one <see cref="EvalCase"/> against a produced answer.</summary>
public sealed record EvalCaseResult(
    string Id,
    bool Passed,
    IReadOnlyList<string> Failures,
    double DurationSeconds,
    bool IsGrounded,
    int CitationCount);

/// <summary>Aggregate result of an eval run.</summary>
public sealed record EvalReport(IReadOnlyList<EvalCaseResult> Results)
{
    public int Total => Results.Count;
    public int Passed => Results.Count(r => r.Passed);
    public int Failed => Total - Passed;
    public double PassRate => Total == 0 ? 1.0 : (double)Passed / Total;

    /// <summary>A concise human-readable summary of the run.</summary>
    public string Summary()
    {
        var lines = new List<string> { $"Evals: {Passed}/{Total} passed ({PassRate:P0})." };
        foreach (var r in Results)
        {
            var status = r.Passed ? "PASS" : "FAIL";
            lines.Add($"  [{status}] {r.Id} ({r.DurationSeconds:F1}s, grounded={r.IsGrounded}, citations={r.CitationCount})");
            foreach (var f in r.Failures)
            {
                lines.Add($"         - {f}");
            }
        }

        return string.Join(Environment.NewLine, lines);
    }
}

/// <summary>
/// Runs answer-quality eval cases against an <see cref="IAnswerService"/> and checks each case's
/// deterministic expectations. Pure orchestration — the answer service can be the real agentic
/// pipeline (live evals) or a fake (unit tests of the checks themselves).
/// </summary>
public sealed class EvalRunner(IAnswerService answers)
{
    public async Task<EvalReport> RunAsync(IReadOnlyList<EvalCase> cases, CancellationToken cancellationToken = default)
    {
        var results = new List<EvalCaseResult>(cases.Count);
        foreach (var c in cases)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var start = Stopwatch.GetTimestamp();
            GroundedAnswer answer;
            try
            {
                answer = await answers.AnswerAsync(c.Question, cancellationToken);
            }
            catch (Exception ex)
            {
                results.Add(new EvalCaseResult(c.Id, false, [$"threw: {ex.GetType().Name}: {ex.Message}"],
                    Stopwatch.GetElapsedTime(start).TotalSeconds, false, 0));
                continue;
            }

            var failures = Check(c, answer);
            results.Add(new EvalCaseResult(
                c.Id, failures.Count == 0, failures,
                Stopwatch.GetElapsedTime(start).TotalSeconds, answer.IsGrounded, answer.Citations.Count));
        }

        return new EvalReport(results);
    }

    /// <summary>Evaluates one case's expectations against an answer, returning failure reasons.</summary>
    public static IReadOnlyList<string> Check(EvalCase c, GroundedAnswer answer)
    {
        var failures = new List<string>();
        var text = answer.Answer ?? string.Empty;

        if (c.MustBeGrounded is { } grounded && answer.IsGrounded != grounded)
        {
            failures.Add(grounded
                ? "expected a grounded answer but the bot refused/didn't ground it"
                : "expected a refusal but the bot produced a grounded answer");
        }

        foreach (var needle in c.CitationsContainAll)
        {
            var found = answer.Citations.Any(cit =>
                Contains(cit.Url, needle) || Contains(cit.Title, needle));
            if (!found)
            {
                failures.Add($"no citation references '{needle}'");
            }
        }

        foreach (var needle in c.AnswerContainsAll)
        {
            if (!Contains(text, needle))
            {
                failures.Add($"answer is missing required text '{needle}'");
            }
        }

        if (c.AnswerContainsAny.Length > 0 && !c.AnswerContainsAny.Any(n => Contains(text, n)))
        {
            failures.Add($"answer contains none of the expected alternatives [{string.Join(", ", c.AnswerContainsAny)}]");
        }

        foreach (var needle in c.AnswerContainsNone)
        {
            if (Contains(text, needle))
            {
                failures.Add($"answer contains forbidden text '{needle}'");
            }
        }

        return failures;
    }

    private static bool Contains(string? haystack, string needle) =>
        !string.IsNullOrEmpty(haystack) && haystack.Contains(needle, StringComparison.OrdinalIgnoreCase);
}
