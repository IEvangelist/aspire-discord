$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$path = Join-Path $repoRoot 'infra\deploy-production.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('New-DeploymentParameterFile', 'Invoke-AppDeployment')) {
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
Write-Output 'Foundation and parameter-file regression checks passed.'
