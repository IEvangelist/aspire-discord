$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$path = Join-Path $repoRoot 'infra\deploy-production.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$cliFunction = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-StagedAzureCli'
}, $true)
if ($cliFunction.Extent.Text -notmatch 'Get-Command az[^)]*Select-Object -First 1') {
    throw 'Azure CLI discovery must select exactly one executable.'
}
foreach ($name in @('New-DeploymentParameterFile', 'Invoke-AppDeployment', 'Test-StagedFeatures')) {
    $function = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }.GetNewClosure(), $true)
    Invoke-Expression $function.Extent.Text
}
$foundationCall = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -eq 'az' -and $node.Extent.Text -match 'foundation-\$runId'
}, $true)
$ancestor = $foundationCall.Parent
while ($ancestor -and $ancestor -isnot [System.Management.Automation.Language.IfStatementAst]) { $ancestor = $ancestor.Parent }
if (-not $ancestor -or $ancestor.Clauses[0].Item1.Extent.Text -ne '-not $UseExistingFoundation') {
    throw 'Foundation deployment is not guarded by explicit legacy mode.'
}
$cleanup = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Remove-LegacyQdrantStorage'
}, $true)
$ancestor = $cleanup.Parent
while ($ancestor -and $ancestor -isnot [System.Management.Automation.Language.IfStatementAst]) { $ancestor = $ancestor.Parent }
if (-not $ancestor -or $ancestor.Clauses[0].Item1.Extent.Text -ne '-not $UseExistingFoundation') {
    throw 'Legacy storage cleanup is not guarded.'
}
. (Join-Path $repoRoot 'infra\existing-foundation.ps1')
$script:scenario = ''
function Invoke-FoundationRead {
    param([string[]] $Arguments)
    if ($script:scenario -eq 'missing') { throw 'Required resource missing' }
    if ($Arguments[0] -eq 'group') {
        return @{ id = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"; location = $Location; tags = @{ application = 'aspire-discord' } }
    }
    if ($Arguments[1] -eq 'list') { return @() }
    if ($Arguments[0] -eq 'storage') { return @{ nameAvailable = $script:scenario -ne 'occupied' } }
    if ($Arguments[0] -eq 'role') {
        if ($script:scenario -eq 'missing-role') { return @() }
        return @(@{
            scope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Storage/storageAccounts/aspireissuesffccd7/tableServices/default/tables/IssueDrafts"
            principalId = '16d6bfa3-79e5-4da5-b2d8-b76672588040'
            roleDefinitionId = '/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
        })
    }
    $id = $Arguments[3]
    $name = ($id -split '/')[-1]
    $properties = @{
        provisioningState = 'Succeeded'
        principalId = '16d6bfa3-79e5-4da5-b2d8-b76672588040'
        clientId = 'faabef4a-73b2-4bbd-92b5-bbfbba4f1d1c'
        loginServer = 'aspirediscordffccd7.azurecr.io'
        adminUserEnabled = $false
        disableLocalAuth = $true
        ConnectionString = 'not-a-real-connection-string'
        vnetConfiguration = @{ infrastructureSubnetId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Network/virtualNetworks/aspire-discord-production-vnet/subnets/container-apps" }
        endpoint = if ($name -like '*config') { 'https://aspirediscordffccd7config.azconfig.io' } else { 'https://aspire-discord-ai-ffccd7.openai.azure.com/' }
        allowSharedKeyAccess = $script:scenario -eq 'shared-key'
        defaultToOAuthAuthentication = $true
        allowBlobPublicAccess = $false
        minimumTlsVersion = 'TLS1_2'
        supportsHttpsTrafficOnly = $true
        primaryEndpoints = @{ table = 'https://aspireissuesffccd7.table.core.windows.net/' }
        enableRbacAuthorization = $true
        enablePurgeProtection = $true
        publicNetworkAccess = if ($script:scenario -eq 'public-vault') { 'Enabled' } else { 'Disabled' }
        privateEndpointConnections = @(@{ properties = @{ privateLinkServiceConnectionState = @{ status = 'Approved' } } })
    }
    if ($script:scenario -eq 'wrong-identity') { $properties.principalId = 'wrong' }
    if ($script:scenario -eq 'local-auth') { $properties.disableLocalAuth = $false }
    return @{ id = $id; name = $name; location = $Location; properties = $properties; kind = 'StorageV2'; sku = @{ name = 'Standard_LRS' }; tags = @{ application = 'aspire-discord'; managedBy = 'aspire'; purpose = 'issue-drafts' } }
}
function Assert-Fails {
    param([scriptblock] $Action)
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Expected fail-closed validation.' }
}
$result = Get-ExistingFoundation
if ($result.registryName.value -ne 'aspirediscordffccd7') { throw 'Incorrect foundation discovery outputs.' }
Test-IssueStoragePrerequisites
Get-ExistingFoundation -RequireIssueStorage | Out-Null
foreach ($scenario in @('missing-role', 'shared-key', 'public-vault')) {
    $script:scenario = $scenario
    Assert-Fails { Get-ExistingFoundation -RequireIssueStorage }
}
foreach ($scenario in @('missing', 'wrong-identity', 'local-auth')) {
    $script:scenario = $scenario
    Assert-Fails { Get-ExistingFoundation }
}
$script:scenario = 'occupied'
Assert-Fails { Test-IssueStoragePrerequisites }
$script:scenario = ''
$SubscriptionId = '00000000-0000-0000-0000-000000000000'
Assert-Fails { Get-ExistingFoundation }
$SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8'

$parameterPath = New-DeploymentParameterFile @{ discordToken = @{ value = 'fake-secret-"Unicode-ü' } }
try {
    $data = Get-Content -LiteralPath $parameterPath -Raw | ConvertFrom-Json
    if ($data.parameters.discordToken.value -ne 'fake-secret-"Unicode-ü') { throw 'Parameter roundtrip failed.' }
    if ($IsWindows -and -not (Get-Acl -LiteralPath (Split-Path -Parent $parameterPath)).AreAccessRulesProtected) {
        throw 'Deployment parameter directory must disable inherited ACLs.'
    }
}
finally { Remove-Item -LiteralPath (Split-Path -Parent $parameterPath) -Recurse -Force }
function Assert-DeploymentNotCancelled {}
function az {
    $script:capturedArguments = $args
    $script:capturedPath = ($args | Where-Object { $_ -like '@*parameters.json' }).Substring(1)
    $global:LASTEXITCODE = 1
    'fake-secret-do-not-log'
}
$GitHubIssuesKeyId = ''
$GitHubIssuesAppId = '4968096'
$GitHubIssuesInstallationId = '163850423'
$githubIssuesTableEndpoint = ''
$discordToken = 'fake-secret-discord'
$githubToken = 'fake-secret-github'
$allowedUserIds = ''
$imageTag = 'test'
$appTemplate = 'app.bicep'
Assert-Fails { Invoke-AppDeployment -ApplicationName 'aspire-discord-blue' -DeploymentName 'test' -EnableDiscord $false }
if (($script:capturedArguments -join ' ') -match 'fake-secret') { throw 'Secrets leaked to CLI arguments.' }
if (Test-Path -LiteralPath $script:capturedPath) { throw 'Failed deployment left secret parameters behind.' }

$stageWait = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -eq 'Wait-Application' -and $node.Extent.Text -match '-ExpectDiscord \$false'
}, $true)
$probeCall = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Test-StagedFeatures'
}, $true)
$deactivate = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -eq 'Set-RevisionActive' -and $node.Extent.Text -match '-Active \$false'
}, $true)
if (-not $probeCall -or $probeCall.Extent.StartOffset -le $stageWait.Extent.EndOffset -or
    $probeCall.Extent.EndOffset -ge $deactivate.Extent.StartOffset) {
    throw 'Staged feature checks must follow disabled readiness and precede source deactivation.'
}
$ancestor = $probeCall.Parent
while ($ancestor -and $ancestor -isnot [System.Management.Automation.Language.IfStatementAst]) { $ancestor = $ancestor.Parent }
if (-not $ancestor -or $ancestor.Clauses[0].Item1.Extent.Text -ne '$GitHubIssuesKeyId') {
    throw 'The isolated release probe must not change legacy deployment behavior.'
}

$sourceApplication = 'aspire-discord-green'
$expectedRevision = 'aspire-discord-blue--s-test'
$script:probeScenario = 'success'
$script:execCalls = 0
$script:revisionReads = 0
function Start-Sleep {}
function Invoke-StagedAzureCli {
    param([string[]] $Arguments)
    if ($Arguments[1] -eq 'revision') {
        $script:revisionReads++
        $name = if ($script:probeScenario -eq 'wrong-revision') { 'wrong' } else { $expectedRevision }
        if ($script:probeScenario -eq 'transition' -and $script:revisionReads -eq 1) {
            return (@(@{name='aspire-discord-blue--s-previous';properties=@{active=$true}},
                @{name=$expectedRevision;properties=@{active=$true}}) | ConvertTo-Json -Depth 5 -AsArray)
        }
        return (@(@{ name = $name; properties = @{ active = $true; healthState = 'Healthy' } }) | ConvertTo-Json -Depth 5 -AsArray)
    }
    if ($Arguments[1] -eq 'replica') {
        return (@(@{ name = 'exact-staged-replica'; properties = @{
            containers = @(@{ name = 'bot'; ready = $script:probeScenario -ne 'not-ready' })
        } }) | ConvertTo-Json -Depth 5 -AsArray)
    }
    $script:execCalls++
    foreach ($pair in @(
        @('--name', 'aspire-discord-blue'), @('--revision', $expectedRevision),
        @('--replica', 'exact-staged-replica'), @('--container', 'bot')
    )) {
        if ($Arguments[[Array]::IndexOf($Arguments, $pair[0]) + 1] -cne $pair[1]) {
            throw 'Diagnostic targeted an unexpected resource.'
        }
    }
    $command = $Arguments[[Array]::IndexOf($Arguments, '--command') + 1]
    if ([Uri]::EscapeDataString($command).Length -gt 1800 -or $command -match 'fake-secret') {
        throw 'Unsafe diagnostic transport.'
    }
    if ($script:probeScenario -eq 'missing-marker') { return 'fake-secret-do-not-log' }
    return "INFO: Connected`r`nASPIRE_STAGED_FEATURES_OK`r`n"
}
Test-StagedFeatures -ApplicationName 'aspire-discord-blue' -ExpectedRevision $expectedRevision
if ($script:execCalls -ne 1) { throw 'The staged feature diagnostic did not execute exactly once.' }
$script:probeScenario = 'transition'
$script:revisionReads = 0
Test-StagedFeatures -ApplicationName 'aspire-discord-blue' -ExpectedRevision $expectedRevision
if ($script:revisionReads -ne 2) { throw 'The staging revision transition was not awaited.' }
foreach ($scenario in @('wrong-revision', 'not-ready', 'missing-marker')) {
    $script:probeScenario = $scenario
    Assert-Fails { Test-StagedFeatures -ApplicationName 'aspire-discord-blue' -ExpectedRevision $expectedRevision }
}
Assert-Fails { Test-StagedFeatures -ApplicationName $sourceApplication -ExpectedRevision $expectedRevision }
Assert-Fails { Test-StagedFeatures -ApplicationName 'other-app' -ExpectedRevision $expectedRevision }

$probeTests = @'
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(process.argv[1], 'utf8').replaceAll('import(', 'load(');
(async () => {
  for (const scenario of ['ok', 'empty-table', 'no-token', 'no-table', 'no-key', 'discord', 'ungrounded', 'one-repo', 'not-covered', 'partial', 'mcp-failure', 'mcp-one-repo', 'table-failure', 'no-identity', 'model']) {
    const logs = [];
    let tableReads = 0;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const config = {
      discord: { token: scenario === 'discord' ? 'fake-secret' : undefined },
      githubMcp: { token: scenario === 'no-token' ? undefined : 'fake-secret' },
      issues: { keyId: scenario === 'no-key' ? undefined : 'test-key-id', tableEndpoint: scenario === 'no-table' ? undefined : 'https://example.table.core.windows.net', tableName: 'IssueDrafts' },
    };
    class Reader { constructor() {} }
    class Service {
      constructor(reader, github, runtime) { this.runtime = runtime; }
      async tryAnswer(question) {
        assert.equal(question, 'look at issue reports from afscrome this month');
        if (scenario === 'model') return this.runtime.complete();
        return {
          source: 'github', isGrounded: scenario !== 'ungrounded',
          answer: scenario === 'not-covered' ? 'NOT_COVERED' : `${scenario === 'partial' ? 'partial: ' : ''}microsoft/aspire microsoft/aspire.dev`,
          citations: (scenario === 'one-repo' ? ['microsoft/aspire'] : ['microsoft/aspire', 'microsoft/aspire.dev']).map(repo => ({ repo })),
        };
      }
    }
    class TableClient {
      listEntities(options) {
        assert.equal(options.queryOptions.top, 1);
        assert.deepEqual(Array.from(options.queryOptions.select), ['PartitionKey', 'RowKey']);
        assert.ok(options.abortSignal);
        return { next: async () => {
          tableReads++;
          if (scenario === 'table-failure') throw Error('fake-secret-do-not-log');
          return { done: scenario === 'empty-table', value: { partitionKey: 'private' } };
        }};
      }
    }
    class ManagedIdentityCredential {
      constructor(options) { assert.equal(options.clientId, 'explicit-client-id'); }
    }
    class CitationRegistry { all = []; }
    class ToolBudget { constructor(count) { assert.equal(count, 2); } }
    class GitHubMcpClient {
      createTools(citations, budget, signal) {
        assert.ok(signal);
        return [{name:'search_issues', handler: async () => {
          if (scenario === 'mcp-failure') throw Error('fake-secret-do-not-log');
          citations.all = (scenario === 'mcp-one-repo' ? ['microsoft/aspire'] :
            ['microsoft/aspire','microsoft/aspire.dev']).map(repo => ({repo}));
          return 'microsoft/aspire microsoft/aspire.dev';
        }}];
      }
      async close() {}
    }
    vm.runInNewContext(source, {
      load: async name => {
        if (name.endsWith('/config.js')) return { loadConfig: () => config };
        if (name.endsWith('/github-activity.js')) return { GitHubActivityReader: Reader };
        if (name.endsWith('/github-read-service.js')) return { GitHubReadService: Service };
        if (name.endsWith('/github-mcp.js')) return { GitHubMcpClient };
        if (name.endsWith('/citations.js')) return { CitationRegistry };
        if (name.endsWith('/tool-budget.js')) return { ToolBudget };
        if (name === '@azure/data-tables') return { TableClient };
        if (name === '@azure/identity') return { ManagedIdentityCredential };
        throw Error('Unexpected import');
      },
      console: { log: text => logs.push(text) },
      process: { env: { AZURE_CLIENT_ID: scenario === 'no-identity' ? undefined : 'explicit-client-id' }, exit: code => finish(code) },
      setTimeout: (_, delay) => assert.equal(delay, 90000),
      AbortSignal, fetch: () => { throw Error('Network is forbidden in regression checks'); },
    });
    const code = await done;
    const success = ['ok', 'empty-table'].includes(scenario);
    assert.equal(code, success ? 0 : 1, scenario);
    assert.deepEqual(logs, [success ? 'ASPIRE_STAGED_FEATURES_OK' : 'ASPIRE_STAGED_FEATURES_FAILED'], scenario);
    if (success) assert.equal(tableReads, 1);
  }
  console.log('Offline staged feature probe checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
'@
& node -e $probeTests (Join-Path $repoRoot 'infra\verify-staged-features.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Offline staged feature probe checks failed.' }
Write-Output 'Foundation and parameter-file regression checks passed.'
$policyAst = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $repoRoot 'infra\set-runtime-config.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Policy helper contains syntax errors.' }
$policyFunction = $policyAst.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'ConvertTo-IssuePolicyJson'
}, $true)
Invoke-Expression $policyFunction.Extent.Text
$policyText = '{"enabled":true,"allowedUserIds":["123"],"allowedChannelIds":[],"allowedGuildIds":["789"],"allowedRepositories":["microsoft/aspire"]}'
$policyResult = ConvertTo-IssuePolicyJson $policyText | ConvertFrom-Json
if ($policyResult.allowedGuildIds[0] -ne '789' -or $policyResult.allowedChannelIds.Count -ne 0) {
    throw 'Explicit server-wide policy was not preserved.'
}
foreach ($invalid in @(
    $policyText.Replace('["789"]','[]'),
    $policyText.Replace('["789"]','["*"]'),
    $policyText.Replace('"allowedGuildIds":["789"],',''),
    $policyText.Replace('["123"]','[]'),
    $policyText.Replace('["microsoft/aspire"]','[]')
)) { Assert-Fails { ConvertTo-IssuePolicyJson $invalid } }
Write-Output 'Server-wide issue policy regression checks passed.'
