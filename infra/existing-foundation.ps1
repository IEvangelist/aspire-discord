[CmdletBinding()]
param(
    [string] $SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8',
    [string] $ResourceGroup = 'aspire-discord-prod',
    [string] $Location = 'centralus',
    [string] $ResourceSuffix = 'ffccd7',
    [switch] $StoragePreflight,
    [switch] $RequireIssueStorage
)

$ErrorActionPreference = 'Stop'

function Assert-ExistingTarget {
    if ($SubscriptionId -ne '11aa9ca6-306a-4ea9-b614-2d413efd04a8' -or
        $ResourceGroup -ne 'aspire-discord-prod' -or $Location -ne 'centralus' -or
        $ResourceSuffix -ne 'ffccd7') {
        throw 'Existing-foundation reuse is restricted to the approved production target.'
    }
    $group = Invoke-FoundationRead @('group', 'show', '--subscription', $SubscriptionId, '--name', $ResourceGroup)
    if ($group.id -ine "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup" -or
        $group.tags.application -ne 'aspire-discord' -or $group.location -ne $Location) {
        throw 'The existing production resource group is missing or unowned.'
    }
}

function Invoke-FoundationRead {
    param([string[]] $Arguments)
    $json = @(& az @Arguments --only-show-errors --output json 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read required production metadata; no foundation deployment will be attempted.'
    }
    try { return ($json -join "`n") | ConvertFrom-Json }
    catch { throw 'Invalid production resource metadata.' }
}

function Get-OwnedResource {
    param([string] $Type, [string] $Name, [string] $ApiVersion)
    $id = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/$Type/$Name"
    $resource = Invoke-FoundationRead @('resource', 'show', '--ids', $id, '--api-version', $ApiVersion)
    if ($resource.id -ine $id -or $resource.tags.application -ne 'aspire-discord' -or
        ($resource.location -replace '\s', '') -ine $Location) {
        throw "Required resource '$Name' has unexpected ownership, ID, or region."
    }
    if ($resource.properties.provisioningState -and $resource.properties.provisioningState -ine 'Succeeded') {
        throw "Required resource '$Name' is not successfully provisioned."
    }
    return $resource
}

function Get-ExistingRuntimeIdentity {
    $identity = Get-OwnedResource 'Microsoft.ManagedIdentity/userAssignedIdentities' 'aspire-discord-production-id' '2023-01-31'
    if ($identity.properties.principalId -ne '16d6bfa3-79e5-4da5-b2d8-b76672588040' -or
        $identity.properties.clientId -ne 'faabef4a-73b2-4bbd-92b5-bbfbba4f1d1c') {
        throw 'The production managed identity does not match the approved runtime identity.'
    }
    return $identity
}

function Assert-IssueStoragePosture {
    param($Storage)
    if ($Storage.kind -ne 'StorageV2' -or $Storage.sku.name -ne 'Standard_LRS' -or
        $Storage.tags.managedBy -ne 'aspire' -or $Storage.tags.purpose -ne 'issue-drafts' -or
        $Storage.properties.allowSharedKeyAccess -ne $false -or
        $Storage.properties.defaultToOAuthAuthentication -ne $true -or
        $Storage.properties.allowBlobPublicAccess -ne $false -or
        $Storage.properties.minimumTlsVersion -ne 'TLS1_2' -or
        $Storage.properties.supportsHttpsTrafficOnly -ne $true) {
        throw 'Existing issue storage has unexpected ownership or keyless storage posture.'
    }
}

function Test-IssueStoragePrerequisites {
    Assert-ExistingTarget
    Get-ExistingRuntimeIdentity | Out-Null
    $resources = @(Invoke-FoundationRead @('resource', 'list', '--subscription', $SubscriptionId,
        '--resource-group', $ResourceGroup, '--resource-type', 'Microsoft.Storage/storageAccounts'))
    $existing = @($resources | Where-Object name -eq 'aspireissuesffccd7')
    if ($existing.Count -gt 1) { throw 'Issue storage is not uniquely identified.' }
    if ($existing.Count -eq 1) {
        $storage = Get-OwnedResource 'Microsoft.Storage/storageAccounts' 'aspireissuesffccd7' '2023-05-01'
        Assert-IssueStoragePosture $storage
    }
    else {
        $availability = Invoke-FoundationRead @('storage', 'account', 'check-name', '--name', 'aspireissuesffccd7', '--subscription', $SubscriptionId)
        if ($availability.nameAvailable -ne $true) { throw 'Issue storage name is unavailable outside the owned target.' }
    }
}

function Get-ExistingFoundation {
    param([switch] $RequireIssueStorage)
    Assert-ExistingTarget
    Get-ExistingRuntimeIdentity | Out-Null
    $registry = Get-OwnedResource 'Microsoft.ContainerRegistry/registries' "aspirediscord$ResourceSuffix" '2023-07-01'
    $environment = Get-OwnedResource 'Microsoft.App/managedEnvironments' 'aspire-discord-production-env' '2025-07-01'
    $search = Get-OwnedResource 'Microsoft.Search/searchServices' "aspire-discord-search-$ResourceSuffix" '2025-05-01'
    $foundry = Get-OwnedResource 'Microsoft.CognitiveServices/accounts' "aspire-discord-ai-$ResourceSuffix" '2024-10-01'
    $insights = Get-OwnedResource 'Microsoft.Insights/components' 'aspire-discord-production-insights' '2020-02-02'
    $config = Get-OwnedResource 'Microsoft.AppConfiguration/configurationStores' "aspirediscord${ResourceSuffix}config" '2024-06-01'
    $subnetId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Network/virtualNetworks/aspire-discord-production-vnet/subnets/container-apps"
    if ($registry.properties.loginServer -ne "aspirediscord$ResourceSuffix.azurecr.io" -or
        $registry.properties.adminUserEnabled -ne $false -or
        $environment.properties.vnetConfiguration.infrastructureSubnetId -ine $subnetId -or
        $search.properties.disableLocalAuth -ne $true -or $foundry.properties.disableLocalAuth -ne $true -or
        $config.properties.disableLocalAuth -ne $true -or
        $config.properties.endpoint.TrimEnd('/') -ne "https://aspirediscord${ResourceSuffix}config.azconfig.io" -or
        $foundry.properties.endpoint.TrimEnd('/') -ne "https://aspire-discord-ai-$ResourceSuffix.openai.azure.com" -or
        [string]::IsNullOrWhiteSpace($insights.properties.ConnectionString)) {
        throw 'Required foundation endpoints, identity authentication, or Container Apps subnet are unexpected.'
    }
    $tableEndpoint = ''
    if ($RequireIssueStorage) {
        $storage = Get-OwnedResource 'Microsoft.Storage/storageAccounts' 'aspireissuesffccd7' '2023-05-01'
        Assert-IssueStoragePosture $storage
        $tableId = "$($storage.id)/tableServices/default/tables/IssueDrafts"
        $table = Invoke-FoundationRead @('resource', 'show', '--ids', $tableId, '--api-version', '2023-05-01')
        if ($table.id -ine $tableId) { throw 'IssueDrafts table is missing.' }
        $assignments = @(Invoke-FoundationRead @('role', 'assignment', 'list', '--subscription', $SubscriptionId, '--scope', $tableId))
        if (@($assignments | Where-Object {
            $_.scope -ieq $tableId -and
            $_.principalId -eq '16d6bfa3-79e5-4da5-b2d8-b76672588040' -and
            $_.roleDefinitionId -like '*/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
        }).Count -ne 1) { throw 'The approved table-scoped runtime identity role is missing or ambiguous.' }
        $tableEndpoint = [string]$storage.properties.primaryEndpoints.table
        if ($tableEndpoint.TrimEnd('/') -ne 'https://aspireissuesffccd7.table.core.windows.net') {
            throw 'Unexpected issue table endpoint.'
        }
        $vault = Get-OwnedResource 'Microsoft.KeyVault/vaults' 'aspire-issues-ffccd7' '2023-07-01'
        if ($vault.properties.enableRbacAuthorization -ne $true -or
            $vault.properties.enablePurgeProtection -ne $true -or
            $vault.properties.publicNetworkAccess -ne 'Disabled' -or
            @($vault.properties.privateEndpointConnections | Where-Object {
                $_.properties.privateLinkServiceConnectionState.status -eq 'Approved'
            }).Count -lt 1) {
            throw 'The existing issue signing vault is not private, RBAC-enabled, and purge-protected.'
        }
    }
    return [pscustomobject]@{
        registryName = @{ value = $registry.name }
        runtimeConfigName = @{ value = $config.name }
        searchEndpoint = @{ value = "https://$($search.name).search.windows.net" }
        githubIssuesTableEndpoint = @{ value = $tableEndpoint }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($StoragePreflight) { Test-IssueStoragePrerequisites }
    else { Get-ExistingFoundation -RequireIssueStorage:$RequireIssueStorage | Out-Null }
}
