[CmdletBinding()]
param(
    [string] $SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8',
    [string] $ResourceGroup = 'aspire-discord-prod',
    [string] $Location = 'centralus',
    [string] $ResourceSuffix = 'ffccd7',
    [switch] $SkipBuild,
    [switch] $StopLocalAppHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$appHostPath = Join-Path $repoRoot 'AspireDiscordBot.AppHost\apphost.mts'

function Invoke-AzureCli {
    param([Parameter(ValueFromRemainingArguments)][string[]] $Arguments)

    & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')"
    }
}

function Get-DeploymentSecret {
    param(
        [string] $EnvironmentName,
        [string] $AspireKey,
        [switch] $Optional
    )

    $value = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if ([string]::IsNullOrWhiteSpace($value)) {
        $output = @(& aspire secret get $AspireKey --apphost $appHostPath --non-interactive --nologo 2>$null)
        if ($LASTEXITCODE -eq 0) {
            $value = ($output | Select-Object -Last 1).Trim()
        }
    }
    if ([string]::IsNullOrWhiteSpace($value) -and -not $Optional) {
        throw "Set $EnvironmentName or configure Aspire secret '$AspireKey'."
    }
    return $value
}

Set-Location $repoRoot
if (git status --porcelain) {
    throw 'Commit the deployment source before building immutable images.'
}

$imageTag = (git rev-parse --short=12 HEAD).Trim()
$runId = Get-Date -Format 'yyMMddHHmmss'
$revisionSuffix = "r-$($imageTag.Substring(0, 7))-$runId"

Invoke-AzureCli account show --subscription $SubscriptionId --output none
Invoke-AzureCli group create `
    --subscription $SubscriptionId `
    --name $ResourceGroup `
    --location $Location `
    --tags application=aspire-discord environment=production managedBy=bicep `
    --output none

$foundationJson = & az deployment group create `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --name "foundation-$runId" `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters location=$Location resourceSuffix=$ResourceSuffix environmentName=production `
    --query properties.outputs `
    --output json
if ($LASTEXITCODE -ne 0) {
    throw 'Azure foundation deployment failed.'
}
$foundation = $foundationJson | ConvertFrom-Json
$registryName = $foundation.registryName.value
$storageName = $foundation.storageName.value

Invoke-AzureCli storage account file-service-properties update `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --account-name $storageName `
    --nfs-eit `
    --require-nfs-encryption-in-transit false `
    --output none

if (-not $SkipBuild) {
    Invoke-AzureCli acr build `
        --subscription $SubscriptionId `
        --registry $registryName `
        --image "aspire-discord-bot:$imageTag" `
        --file (Join-Path $repoRoot 'AspireDiscordBot.Bot\Dockerfile') `
        $repoRoot
    Invoke-AzureCli acr build `
        --subscription $SubscriptionId `
        --registry $registryName `
        --image "aspire-discord-ingestion:$imageTag" `
        --file (Join-Path $repoRoot 'AspireDiscordBot.Ingestion\Dockerfile') `
        $repoRoot
    Invoke-AzureCli acr import `
        --subscription $SubscriptionId `
        --name $registryName `
        --source 'docker.io/qdrant/qdrant:v1.18.0' `
        --image 'qdrant:v1.18.0' `
        --force `
        --output none
}

$discordToken = Get-DeploymentSecret `
    -EnvironmentName 'DISCORD_TOKEN' `
    -AspireKey 'Parameters:DiscordToken'
$githubToken = Get-DeploymentSecret `
    -EnvironmentName 'GITHUB_MCP_TOKEN' `
    -AspireKey 'Parameters:GitHubMcpToken'
$allowedUserIds = Get-DeploymentSecret `
    -EnvironmentName 'DISCORD_ALLOWED_USER_IDS' `
    -AspireKey 'Parameters:DiscordAllowedUserIds' `
    -Optional
$random = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$qdrantApiKey = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+', '-').Replace('/', '_')

if ($StopLocalAppHost) {
    & aspire stop --apphost $appHostPath --non-interactive --nologo
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to stop the local AppHost before cloud cutover.'
    }
}

$applicationName = 'aspire-discord-production'
$previousRevision = & az containerapp revision list `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --name $applicationName `
    --query '[?properties.active].name | [0]' `
    --output tsv 2>$null
if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($previousRevision)) {
    Invoke-AzureCli containerapp revision deactivate `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $applicationName `
        --revision $previousRevision `
        --output none
}

$appJson = & az deployment group create `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --name "application-$runId" `
    --template-file (Join-Path $PSScriptRoot 'app.bicep') `
    --parameters `
        location=$Location `
        resourceSuffix=$ResourceSuffix `
        environmentName=production `
        imageTag=$imageTag `
        revisionSuffix=$revisionSuffix `
        discordToken=$discordToken `
        githubToken=$githubToken `
        qdrantApiKey=$qdrantApiKey `
        discordAllowedUserIds=$allowedUserIds `
    --query properties.outputs `
    --output json
if ($LASTEXITCODE -ne 0) {
    if (-not [string]::IsNullOrWhiteSpace($previousRevision)) {
        & az containerapp revision activate `
            --subscription $SubscriptionId `
            --resource-group $ResourceGroup `
            --name $applicationName `
            --revision $previousRevision `
            --output none
    }
    throw 'Azure application deployment failed.'
}
$application = $appJson | ConvertFrom-Json
$applicationUrl = $application.applicationUrl.value

$deadline = [DateTimeOffset]::UtcNow.AddMinutes(45)
do {
    try {
        $status = Invoke-RestMethod -Uri "$applicationUrl/ready" -TimeoutSec 15
        if ($status.ready -eq $true) {
            break
        }
    }
    catch {
        Write-Host "Waiting for $applicationUrl/ready ..."
    }
    Start-Sleep -Seconds 20
} while ([DateTimeOffset]::UtcNow -lt $deadline)

if ($status.ready -ne $true) {
    throw "Container App did not become ready within 45 minutes. Inspect: az containerapp logs show --name $($application.applicationName.value) --resource-group $ResourceGroup"
}

[pscustomobject]@{
    Application = $application.applicationName.value
    DiscordEnabled = $true
    ImageTag = $imageTag
    ResourceGroup = $ResourceGroup
    SubscriptionId = $SubscriptionId
    Url = $applicationUrl
} | Format-List
