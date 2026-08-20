using AspireDiscordBot.Core.Evals;
using AspireDiscordBot.Core.Rag;

namespace AspireDiscordBot.Tests;

public class EvalRunnerTests
{
    private static GroundedAnswer Grounded(string text, params Citation[] citations) => new()
    {
        IsGrounded = true,
        Answer = text,
        Citations = citations,
    };

    [Fact]
    public void Passes_WhenAllExpectationsMet()
    {
        var c = new EvalCase
        {
            Id = "x",
            Question = "q",
            MustBeGrounded = true,
            CitationsContainAll = ["efcore/migrations"],
            AnswerContainsAll = ["AddEFMigrations"],
            AnswerContainsAny = ["bundle", "worker"],
            AnswerContainsNone = ["NOT_COVERED"],
        };
        var answer = Grounded(
            "Use AddEFMigrations and publish a migration bundle.",
            new Citation(1, "Apply EF Core migrations", "https://aspire.dev/integrations/databases/efcore/migrations/", "microsoft/aspire.dev"));

        Assert.Empty(EvalRunner.Check(c, answer));
    }

    [Fact]
    public void Fails_WhenGroundingExpectationWrong()
    {
        var refuseCase = new EvalCase { Id = "x", Question = "q", MustBeGrounded = false };
        var groundedAnswer = Grounded("Here is an answer.");
        Assert.Contains(EvalRunner.Check(refuseCase, groundedAnswer), f => f.Contains("expected a refusal"));

        var groundedCase = new EvalCase { Id = "y", Question = "q", MustBeGrounded = true };
        var refusal = GroundedAnswer.NotFound("Not covered.");
        Assert.Contains(EvalRunner.Check(groundedCase, refusal), f => f.Contains("expected a grounded answer"));
    }

    [Fact]
    public void Fails_OnMissingCitation_MissingText_ForbiddenText()
    {
        var c = new EvalCase
        {
            Id = "x",
            Question = "q",
            CitationsContainAll = ["custom-resource-commands"],
            AnswerContainsAll = ["WithCommand"],
            AnswerContainsNone = ["NOT_COVERED"],
        };
        var answer = Grounded(
            "You cannot do this. NOT_COVERED-ish.",
            new Citation(1, "Some doc", "https://aspire.dev/other/", "repo"));

        var failures = EvalRunner.Check(c, answer);
        Assert.Contains(failures, f => f.Contains("no citation references 'custom-resource-commands'"));
        Assert.Contains(failures, f => f.Contains("missing required text 'WithCommand'"));
        Assert.Contains(failures, f => f.Contains("forbidden text 'NOT_COVERED'"));
    }

    [Fact]
    public void AnyOf_FailsOnlyWhenNoneMatch()
    {
        var c = new EvalCase { Id = "x", Question = "q", AnswerContainsAny = ["Parent", "exec", "WithCommand"] };
        Assert.Empty(EvalRunner.Check(c, Grounded("Use the Parent resource.")));
        Assert.Contains(EvalRunner.Check(c, Grounded("Totally unrelated text.")),
            f => f.Contains("none of the expected alternatives"));
    }

    [Fact]
    public async Task RunAsync_ProducesReport_AndCapturesThrows()
    {
        var cases = new[]
        {
            new EvalCase { Id = "ok", Question = "q1", MustBeGrounded = true },
            new EvalCase { Id = "boom", Question = "q2" },
        };
        var runner = new EvalRunner(new ScriptedAnswers());
        var report = await runner.RunAsync(cases);

        Assert.Equal(2, report.Total);
        Assert.Equal(1, report.Passed);
        Assert.Contains(report.Results, r => r.Id == "boom" && !r.Passed && r.Failures.Any(f => f.Contains("threw")));
        Assert.Contains("passed", report.Summary());
    }

    [Fact]
    public void Fixture_IsNonEmpty_AndWellFormed()
    {
        var cases = EvalFixture.Default();
        Assert.NotEmpty(cases);
        Assert.All(cases, c =>
        {
            Assert.False(string.IsNullOrWhiteSpace(c.Id));
            Assert.False(string.IsNullOrWhiteSpace(c.Question));
        });
        Assert.Equal(cases.Count, cases.Select(c => c.Id).Distinct().Count()); // unique ids
    }

    /// <summary>Deterministic answer service: "q1" grounds, "q2" throws.</summary>
    private sealed class ScriptedAnswers : IAnswerService
    {
        public Task<GroundedAnswer> AnswerAsync(string question, CancellationToken cancellationToken = default) =>
            question == "q2"
                ? throw new InvalidOperationException("kaboom")
                : Task.FromResult(Grounded("An Aspire answer."));
    }
}
