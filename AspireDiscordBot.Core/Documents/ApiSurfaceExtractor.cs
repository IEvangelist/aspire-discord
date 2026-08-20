using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AspireDiscordBot.Core.Documents;

/// <summary>A single public type extracted from source, rendered as searchable API documentation.</summary>
public sealed record ApiTypeDoc(
    string Namespace,
    string TypeName,
    string Kind,
    string RelativePath,
    string Body);

/// <summary>
/// Extracts the <b>public API surface</b> (public/protected types and members, with their XML doc
/// comments and signatures) from C# source using Roslyn syntax parsing. This turns the
/// microsoft/aspire source of truth into concise, searchable API docs — the real method names,
/// signatures, and doc comments that plain prose docs often don't spell out.
/// </summary>
public static class ApiSurfaceExtractor
{
    /// <summary>Parses one C# file and yields an API doc per public/protected type it declares.</summary>
    public static IEnumerable<ApiTypeDoc> Extract(string sourceText, string relativePath)
    {
        SyntaxNode root;
        try
        {
            root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
        }
        catch
        {
            yield break;
        }

        foreach (var type in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            // Only top-level public/protected types (skip members nested inside non-public types).
            if (!IsPubliclyVisible(type))
            {
                continue;
            }

            var doc = BuildTypeDoc(type, relativePath);
            if (doc is not null)
            {
                yield return doc;
            }
        }
    }

    private static ApiTypeDoc? BuildTypeDoc(BaseTypeDeclarationSyntax type, string relativePath)
    {
        var ns = GetNamespace(type);
        var kind = TypeKind(type);
        var typeName = type.Identifier.Text + GenericParams(type);
        var header = $"{Modifiers(type.Modifiers)} {kind} {typeName}{BaseList(type)}".Trim();

        var sb = new StringBuilder();
        sb.AppendLine($"Namespace: {ns}");
        sb.AppendLine(header);

        var summary = ExtractDocSummary(type);
        if (!string.IsNullOrEmpty(summary))
        {
            sb.AppendLine($"Summary: {summary}");
        }

        var members = type is TypeDeclarationSyntax typeDecl ? DescribeMembers(typeDecl) : DescribeEnum(type);
        if (members.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("Members:");
            foreach (var m in members)
            {
                sb.AppendLine($"- {m}");
            }
        }

        return new ApiTypeDoc(ns, type.Identifier.Text, kind, relativePath, sb.ToString().TrimEnd());
    }

    private static List<string> DescribeMembers(TypeDeclarationSyntax type)
    {
        // Interface members are implicitly public (no explicit modifier), so include them unless
        // explicitly private; for classes/structs/records require public/protected.
        var isInterface = type is InterfaceDeclarationSyntax;
        var lines = new List<string>();
        foreach (var member in type.Members)
        {
            if (!IsPublicMember(member, isInterface))
            {
                continue;
            }

            var signature = member switch
            {
                MethodDeclarationSyntax m =>
                    $"{Modifiers(m.Modifiers)} {m.ReturnType} {m.Identifier}{m.TypeParameterList}{ParamList(m.ParameterList)}",
                ConstructorDeclarationSyntax c =>
                    $"{Modifiers(c.Modifiers)} {c.Identifier}{ParamList(c.ParameterList)}",
                PropertyDeclarationSyntax p =>
                    $"{Modifiers(p.Modifiers)} {p.Type} {p.Identifier} {{ {Accessors(p)} }}",
                EventDeclarationSyntax e =>
                    $"{Modifiers(e.Modifiers)} event {e.Type} {e.Identifier}",
                EventFieldDeclarationSyntax ef =>
                    $"{Modifiers(ef.Modifiers)} event {ef.Declaration.Type} {Names(ef.Declaration)}",
                FieldDeclarationSyntax f =>
                    $"{Modifiers(f.Modifiers)} {f.Declaration.Type} {Names(f.Declaration)}",
                _ => null,
            };

            if (signature is null)
            {
                continue;
            }

            signature = Normalize(signature);
            var memberSummary = ExtractDocSummary(member);
            lines.Add(string.IsNullOrEmpty(memberSummary) ? signature : $"{signature} — {memberSummary}");
        }

        return lines;
    }

    private static List<string> DescribeEnum(BaseTypeDeclarationSyntax type)
    {
        if (type is not EnumDeclarationSyntax enumDecl)
        {
            return [];
        }

        var lines = new List<string>();
        foreach (var member in enumDecl.Members)
        {
            var memberSummary = ExtractDocSummary(member);
            lines.Add(string.IsNullOrEmpty(memberSummary) ? member.Identifier.Text : $"{member.Identifier.Text} — {memberSummary}");
        }

        return lines;
    }

    private static bool IsPubliclyVisible(BaseTypeDeclarationSyntax type)
    {
        // The type itself and every enclosing type must be public or protected.
        for (SyntaxNode? node = type; node is not null; node = node.Parent)
        {
            if (node is BaseTypeDeclarationSyntax t)
            {
                if (!HasVisibility(t.Modifiers, out var explicitlyPublic) || !explicitlyPublic)
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool IsPublicMember(MemberDeclarationSyntax member, bool declaringTypeIsInterface)
    {
        var mods = member switch
        {
            BaseMethodDeclarationSyntax m => m.Modifiers,
            BasePropertyDeclarationSyntax p => p.Modifiers,
            BaseFieldDeclarationSyntax f => f.Modifiers,
            _ => default,
        };

        // Interface members are implicitly public; include unless explicitly private.
        if (declaringTypeIsInterface)
        {
            return !mods.Any(SyntaxKind.PrivateKeyword);
        }

        if (mods.Count == 0)
        {
            return false;
        }

        return (mods.Any(SyntaxKind.PublicKeyword) || mods.Any(SyntaxKind.ProtectedKeyword))
            && !mods.Any(SyntaxKind.PrivateKeyword);
    }

    /// <summary>True when modifiers include public/protected (out param flags a truly public/protected member).</summary>
    private static bool HasVisibility(SyntaxTokenList modifiers, out bool publicOrProtected)
    {
        publicOrProtected = modifiers.Any(SyntaxKind.PublicKeyword) || modifiers.Any(SyntaxKind.ProtectedKeyword);
        return true;
    }

    private static string GetNamespace(SyntaxNode node)
    {
        for (SyntaxNode? n = node.Parent; n is not null; n = n.Parent)
        {
            switch (n)
            {
                case FileScopedNamespaceDeclarationSyntax fs:
                    return fs.Name.ToString();
                case NamespaceDeclarationSyntax ns:
                    return ns.Name.ToString();
            }
        }

        return "(global)";
    }

    private static string TypeKind(BaseTypeDeclarationSyntax type) => type switch
    {
        RecordDeclarationSyntax r => r.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "record struct" : "record",
        ClassDeclarationSyntax => "class",
        InterfaceDeclarationSyntax => "interface",
        StructDeclarationSyntax => "struct",
        EnumDeclarationSyntax => "enum",
        _ => "type",
    };

    private static string GenericParams(BaseTypeDeclarationSyntax type) =>
        type is TypeDeclarationSyntax { TypeParameterList: { } tp } ? tp.ToString() : string.Empty;

    private static string BaseList(BaseTypeDeclarationSyntax type) =>
        type.BaseList is { } bl ? $" {bl}" : string.Empty;

    private static string Modifiers(SyntaxTokenList modifiers) =>
        string.Join(" ", modifiers.Select(m => m.Text).Where(t => t is not ("private" or "internal")));

    private static string ParamList(ParameterListSyntax? list) => list?.ToString() ?? "()";

    private static string Accessors(PropertyDeclarationSyntax p)
    {
        if (p.AccessorList is null)
        {
            return "get;";
        }

        return string.Join(" ", p.AccessorList.Accessors
            .Where(a => !a.Modifiers.Any(SyntaxKind.PrivateKeyword) && !a.Modifiers.Any(SyntaxKind.InternalKeyword))
            .Select(a => a.Keyword.Text + ";"));
    }

    private static string Names(VariableDeclarationSyntax decl) =>
        string.Join(", ", decl.Variables.Select(v => v.Identifier.Text));

    private static string Normalize(string s) =>
        string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>Extracts and cleans the &lt;summary&gt; text from a node's XML doc comment.</summary>
    private static string ExtractDocSummary(SyntaxNode node)
    {
        var trivia = node.GetLeadingTrivia()
            .Select(t => t.GetStructure())
            .OfType<DocumentationCommentTriviaSyntax>()
            .FirstOrDefault();

        if (trivia is null)
        {
            return string.Empty;
        }

        var summaryElement = trivia.Content
            .OfType<XmlElementSyntax>()
            .FirstOrDefault(e => e.StartTag.Name.LocalName.Text == "summary");

        var raw = summaryElement is not null ? summaryElement.Content.ToString() : trivia.Content.ToString();

        // Strip doc-comment slashes, XML tags, and collapse whitespace.
        var text = raw.Replace("///", " ");
        text = System.Text.RegularExpressions.Regex.Replace(text, "<[^>]+>", " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        text = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return text.Length > 600 ? text[..600] + "…" : text;
    }
}
