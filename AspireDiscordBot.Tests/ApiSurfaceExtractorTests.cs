using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Tests;

public class ApiSurfaceExtractorTests
{
    [Fact]
    public void Extracts_PublicClass_WithSummaryAndMembers()
    {
        const string source = """
            namespace Aspire.Hosting.ApplicationModel;

            /// <summary>A service to execute resource commands.</summary>
            public class ResourceCommandService
            {
                /// <summary>Execute a command for the specified resource.</summary>
                public Task ExecuteCommandAsync(string resourceId, string commandName) => Task.CompletedTask;

                internal void Hidden() { }
                private int _secret;
            }
            """;

        var docs = ApiSurfaceExtractor.Extract(source, "Aspire.Hosting/ResourceCommandService.cs").ToList();

        var doc = Assert.Single(docs);
        Assert.Equal("Aspire.Hosting.ApplicationModel", doc.Namespace);
        Assert.Equal("ResourceCommandService", doc.TypeName);
        Assert.Equal("class", doc.Kind);
        Assert.Contains("A service to execute resource commands.", doc.Body);
        Assert.Contains("ExecuteCommandAsync(string resourceId, string commandName)", doc.Body);
        Assert.Contains("Execute a command for the specified resource.", doc.Body);
        // Internal/private members are excluded from the public API surface.
        Assert.DoesNotContain("Hidden", doc.Body);
        Assert.DoesNotContain("_secret", doc.Body);
    }

    [Fact]
    public void Skips_InternalAndPrivateTypes()
    {
        const string source = """
            namespace N;
            internal class Hidden { public void M() { } }
            class AlsoHidden { }
            public class Shown { }
            """;

        var names = ApiSurfaceExtractor.Extract(source, "N/File.cs").Select(d => d.TypeName).ToList();

        Assert.Single(names);
        Assert.Equal("Shown", names[0]);
    }

    [Fact]
    public void Extracts_Interface_Record_Enum()
    {
        const string source = """
            namespace N;
            /// <summary>An interface.</summary>
            public interface IThing
            {
                /// <summary>Does it.</summary>
                void Do();
            }
            /// <summary>A record.</summary>
            public record Point(int X, int Y);
            /// <summary>A mode.</summary>
            public enum Mode
            {
                /// <summary>The first.</summary>
                One,
                Two
            }
            """;

        var docs = ApiSurfaceExtractor.Extract(source, "N/File.cs").ToList();

        Assert.Contains(docs, d => d.Kind == "interface" && d.TypeName == "IThing" && d.Body.Contains("Does it."));
        Assert.Contains(docs, d => d.Kind == "record" && d.TypeName == "Point");
        var mode = Assert.Single(docs, d => d.Kind == "enum");
        Assert.Contains("One — The first.", mode.Body);
        Assert.Contains("Two", mode.Body);
    }

    [Fact]
    public void Includes_GenericParametersAndBaseList()
    {
        const string source = """
            namespace N;
            /// <summary>Generic thing.</summary>
            public class Box<T> : IThing, IDisposable { }
            """;

        var doc = Assert.Single(ApiSurfaceExtractor.Extract(source, "N/File.cs"));
        Assert.Contains("class Box<T>", doc.Body);
        Assert.Contains("IThing", doc.Body);
    }

    [Fact]
    public void ReturnsNothing_ForInvalidOrEmptySource()
    {
        Assert.Empty(ApiSurfaceExtractor.Extract("", "e.cs"));
        Assert.Empty(ApiSurfaceExtractor.Extract("this is not valid c#$$$", "e.cs"));
    }
}
