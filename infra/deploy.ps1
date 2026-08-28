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
$appTemplate = Join-Path $PSScriptRoot 'app.bicep'
$deploymentLeaseTag = 'AspireDiscordDeploymentLease'

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

function Get-ManagementToken {
    $token = & az account get-access-token `
        --subscription $SubscriptionId `
        --resource 'https://management.azure.com/' `
        --query accessToken `
        --output tsv
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw 'Unable to acquire an Azure Resource Manager token for the deployment lease.'
    }
    return $token.Trim()
}

function Enter-DeploymentLease {
    $uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourcegroups/${ResourceGroup}?api-version=2024-03-01"
    $leaseToken = [Guid]::NewGuid().ToString('N')
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $managementToken = Get-ManagementToken
        $headers = @{ Authorization = "Bearer $managementToken" }
        $response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get
        $resourceGroup = $response.Content | ConvertFrom-Json
        $tags = @{}
        foreach ($property in $resourceGroup.tags.PSObject.Properties) {
            $tags[$property.Name] = [string]$property.Value
        }

        $currentLease = [string]$tags[$deploymentLeaseTag]
        if (-not [string]::IsNullOrWhiteSpace($currentLease)) {
            $parts = $currentLease -split '\|', 2
            $expires = [DateTimeOffset]::MaxValue
            if ($parts.Count -eq 2) {
                try {
                    $expires = [DateTimeOffset]::Parse(
                        $parts[1],
                        [Globalization.CultureInfo]::InvariantCulture)
                }
                catch {
                    $expires = [DateTimeOffset]::MaxValue
                }
            }
            if ($expires -gt [DateTimeOffset]::UtcNow) {
                throw "Another Aspire Discord deployment holds the Azure lease until $expires."
            }
        }

        $leaseExpires = [DateTimeOffset]::UtcNow.AddHours(2).ToString('O')
        $tags[$deploymentLeaseTag] = "$leaseToken|$leaseExpires"
        try {
            Invoke-RestMethod `
                -Uri $uri `
                -Headers @{
                    Authorization = "Bearer $managementToken"
                    'If-Match' = [string]$response.Headers.ETag
                } `
                -Method Patch `
                -ContentType 'application/json' `
                -Body (@{ tags = $tags } | ConvertTo-Json -Compress) | Out-Null
            return $leaseToken
        }
        catch {
            if ($_.Exception.Response.StatusCode.value__ -ne 412 -or $attempt -eq 4) {
                throw
            }
            Start-Sleep -Seconds 2
        }
    }
    throw 'Unable to acquire the Azure deployment lease.'
}

function Exit-DeploymentLease {
    param([string] $LeaseToken)

    if ([string]::IsNullOrWhiteSpace($LeaseToken)) {
        return
    }
    $uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourcegroups/${ResourceGroup}?api-version=2024-03-01"
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $managementToken = Get-ManagementToken
            $headers = @{ Authorization = "Bearer $managementToken" }
            $response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get
            $resourceGroup = $response.Content | ConvertFrom-Json
            $tags = @{}
            foreach ($property in $resourceGroup.tags.PSObject.Properties) {
                $tags[$property.Name] = [string]$property.Value
            }
            $currentLease = [string]$tags[$deploymentLeaseTag]
            if ([string]::IsNullOrWhiteSpace($currentLease) `
                -or -not $currentLease.StartsWith("$LeaseToken|")) {
                return
            }
            $tags.Remove($deploymentLeaseTag)
            Invoke-RestMethod `
                -Uri $uri `
                -Headers @{
                    Authorization = "Bearer $managementToken"
                    'If-Match' = [string]$response.Headers.ETag
                } `
                -Method Patch `
                -ContentType 'application/json' `
                -Body (@{ tags = $tags } | ConvertTo-Json -Compress) | Out-Null
            return
        }
        catch {
            if ($attempt -eq 4) {
                Write-Warning 'Could not release the Azure deployment lease; it expires automatically.'
                return
            }
            Start-Sleep -Seconds 2
        }
    }
}

function Invoke-AppDeployment {
    param(
        [string] $ApplicationName,
        [string] $RevisionSuffix,
        [bool] $EnableDiscord,
        [string] $DeploymentName
    )

    $json = & az deployment group create `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $DeploymentName `
        --template-file $appTemplate `
        --parameters `
            location=$Location `
            resourceSuffix=$ResourceSuffix `
            environmentName=production `
            applicationName=$ApplicationName `
            imageTag=$imageTag `
            revisionSuffix=$RevisionSuffix `
            enableDiscord=$($EnableDiscord.ToString().ToLowerInvariant()) `
            discordToken=$discordToken `
            githubToken=$githubToken `
            discordAllowedUserIds=$allowedUserIds `
        --query properties.outputs `
        --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure application deployment '$DeploymentName' failed."
    }
    return $json | ConvertFrom-Json
}

function Wait-Application {
    param(
        [string] $ApplicationUrl,
        [bool] $ExpectDiscord,
        [TimeSpan] $Timeout = [TimeSpan]::FromMinutes(45)
    )

    $deadline = [DateTimeOffset]::UtcNow.Add($Timeout)
    do {
        try {
            $ready = Invoke-RestMethod -Uri "$ApplicationUrl/ready" -TimeoutSec 15
            $status = Invoke-RestMethod -Uri "$ApplicationUrl/status" -TimeoutSec 15
            $expectedState = if ($ExpectDiscord) { 'ready' } else { 'disabled' }
            if ($ready.ready -eq $true -and $status.state -eq $expectedState) {
                return $status
            }
        }
        catch {
            Write-Host "Waiting for $ApplicationUrl ..."
        }
        Start-Sleep -Seconds 20
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Container App at '$ApplicationUrl' did not reach the expected state."
}

function Get-ActiveRevision {
    param([string] $ApplicationName)

    $revision = & az containerapp revision list `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --query '[?properties.active].name | [0]' `
        --output tsv 2>$null
    if ($LASTEXITCODE -eq 0) {
        return ([string]$revision).Trim()
    }
    throw "Unable to inspect active revisions for Container App '$ApplicationName'."
}

function Set-RevisionActive {
    param(
        [string] $ApplicationName,
        [string] $Revision,
        [bool] $Active
    )

    if ([string]::IsNullOrWhiteSpace($Revision)) {
        return
    }
    $command = if ($Active) { 'activate' } else { 'deactivate' }
    Invoke-AzureCli containerapp revision $command `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --revision $Revision `
        --output none
}

function Get-SourceApplication {
    $json = & az containerapp list `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --output json
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to list existing Container Apps.'
    }

    $candidates = @($json | ConvertFrom-Json) | Where-Object {
        $_.name -in @('aspire-discord-production', 'aspire-discord-blue', 'aspire-discord-green')
    }
    $activeCandidates = @()
    foreach ($candidate in $candidates) {
        $bot = @($candidate.properties.template.containers | Where-Object name -eq 'bot')[0]
        $hasDiscord = $bot -and @($bot.env | Where-Object name -eq 'DISCORD_TOKEN').Count -gt 0
        if ($hasDiscord -and -not [string]::IsNullOrWhiteSpace((Get-ActiveRevision $candidate.name))) {
            $activeCandidates += $candidate.name
        }
    }
    if ($activeCandidates.Count -gt 1) {
        throw "Multiple active Discord bot applications found: $($activeCandidates -join ', ')."
    }
    if ($activeCandidates.Count -eq 1) {
        return $activeCandidates[0]
    }
    return ''
}

function Remove-ContainerApp {
    param([string] $ApplicationName)

    if ([string]::IsNullOrWhiteSpace($ApplicationName)) {
        return
    }

    $json = & az containerapp show `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --output json 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not inspect superseded Container App '$ApplicationName'."
        return
    }
    $application = $json | ConvertFrom-Json
    if ($application.tags.application -ne 'aspire-discord' `
        -or $application.tags.managedBy -ne 'bicep') {
        Write-Warning "Refusing to remove unowned Container App '$ApplicationName'."
        return
    }
    try {
        if (-not [string]::IsNullOrWhiteSpace(
            (Get-ActiveRevision -ApplicationName $ApplicationName))) {
            Write-Warning "Refusing to remove active Container App '$ApplicationName'."
            return
        }
    }
    catch {
        Write-Warning "Cannot verify revision status for '$ApplicationName'; refusing to remove it."
        return
    }

    & az containerapp delete `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --yes `
        --output none
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not remove superseded Container App '$ApplicationName'."
    }
}

function Remove-LegacyQdrantStorage {
    & az containerapp env storage remove `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name 'aspire-discord-production-env' `
        --storage-name 'qdrant-storage' `
        --yes `
        --output none 2>$null

    $storageName = "aspirediscord$ResourceSuffix"
    & az storage account show `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $storageName `
        --output none 2>$null
    if ($LASTEXITCODE -eq 0) {
        & az storage account delete `
            --subscription $SubscriptionId `
            --resource-group $ResourceGroup `
            --name $storageName `
            --yes `
            --output none 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Could not remove the superseded Qdrant storage account.'
        }
    }
}

Set-Location $repoRoot
if (git status --porcelain) {
    throw 'Commit the deployment source before building immutable images.'
}

$imageTag = (git rev-parse --short=12 HEAD).Trim()
$runId = Get-Date -Format 'yyMMddHHmmss'

Invoke-AzureCli account show --subscription $SubscriptionId --output none
$resourceGroupExists = & az group exists `
    --subscription $SubscriptionId `
    --name $ResourceGroup `
    --output tsv
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to determine whether the Azure resource group exists.'
}
if ($resourceGroupExists -ne 'true') {
    Invoke-AzureCli group create `
        --subscription $SubscriptionId `
        --name $ResourceGroup `
        --location $Location `
        --tags application=aspire-discord environment=production managedBy=bicep `
        --output none
}

$deploymentLease = Enter-DeploymentLease
try {
$foundationJson = & az deployment group create `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --name "foundation-$runId" `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters `
        location=$Location `
        resourceSuffix=$ResourceSuffix `
        environmentName=production `
    --query properties.outputs `
    --output json
if ($LASTEXITCODE -ne 0) {
    throw 'Azure foundation deployment failed.'
}
$foundation = $foundationJson | ConvertFrom-Json
$registryName = $foundation.registryName.value

if (-not $SkipBuild) {
    $buildContext = Join-Path ([IO.Path]::GetTempPath()) "aspire-discord-build-$runId-$PID"
    $archivePath = "$buildContext.tar"
    try {
        New-Item -ItemType Directory -Path $buildContext | Out-Null
        & git archive --format=tar --output=$archivePath HEAD
        if ($LASTEXITCODE -ne 0) {
            throw 'Unable to create the immutable Git build context.'
        }
        & tar -xf $archivePath -C $buildContext
        if ($LASTEXITCODE -ne 0) {
            throw 'Unable to extract the immutable Git build context.'
        }

        Invoke-AzureCli acr build `
            --subscription $SubscriptionId `
            --registry $registryName `
            --image "aspire-discord-bot:$imageTag" `
            --file 'AspireDiscordBot.Bot\Dockerfile' `
            --platform 'linux/amd64' `
            $buildContext
        Invoke-AzureCli acr build `
            --subscription $SubscriptionId `
            --registry $registryName `
            --image "aspire-discord-ingestion:$imageTag" `
            --file 'AspireDiscordBot.Ingestion\Dockerfile' `
            --platform 'linux/amd64' `
            $buildContext
    }
    finally {
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $buildContext -Recurse -Force -ErrorAction SilentlyContinue
    }
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

$sourceApplication = Get-SourceApplication
$targetApplication = if ($sourceApplication -eq 'aspire-discord-blue') {
    'aspire-discord-green'
} else {
    'aspire-discord-blue'
}

$stage = Invoke-AppDeployment `
    -ApplicationName $targetApplication `
    -RevisionSuffix "s-$($imageTag.Substring(0, 7))-$runId" `
    -EnableDiscord $false `
    -DeploymentName "stage-$runId"
$applicationUrl = $stage.applicationUrl.value
Wait-Application -ApplicationUrl $applicationUrl -ExpectDiscord $false | Out-Null

if ($StopLocalAppHost) {
    & aspire stop --apphost $appHostPath --non-interactive --nologo
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to stop the local AppHost before cloud cutover.'
    }
}

$sourceRevision = if ([string]::IsNullOrWhiteSpace($sourceApplication)) {
    ''
} else {
    Get-ActiveRevision -ApplicationName $sourceApplication
}
if (-not [string]::IsNullOrWhiteSpace($sourceApplication) `
    -and [string]::IsNullOrWhiteSpace($sourceRevision)) {
    throw "Source application '$sourceApplication' has no active revision."
}
Set-RevisionActive `
    -ApplicationName $sourceApplication `
    -Revision $sourceRevision `
    -Active $false

try {
    $live = Invoke-AppDeployment `
        -ApplicationName $targetApplication `
        -RevisionSuffix "l-$($imageTag.Substring(0, 7))-$runId" `
        -EnableDiscord $true `
        -DeploymentName "live-$runId"
    $applicationUrl = $live.applicationUrl.value
    $status = Wait-Application `
        -ApplicationUrl $applicationUrl `
        -ExpectDiscord $true `
        -Timeout ([TimeSpan]::FromMinutes(10))
}
catch {
    $deploymentFailure = $_
    $targetInactive = $false
    for ($attempt = 1; $attempt -le 3 -and -not $targetInactive; $attempt++) {
        try {
            $targetRevision = Get-ActiveRevision -ApplicationName $targetApplication
            Set-RevisionActive `
                -ApplicationName $targetApplication `
                -Revision $targetRevision `
                -Active $false
            $targetInactive = [string]::IsNullOrWhiteSpace(
                (Get-ActiveRevision -ApplicationName $targetApplication))
        }
        catch {
            Write-Warning "Target deactivation attempt $attempt failed during rollback."
            Start-Sleep -Seconds 5
        }
    }
    if (-not $targetInactive) {
        Write-Warning "Target '$targetApplication' could not be confirmed inactive before source restoration."
    }

    $sourceRestored = [string]::IsNullOrWhiteSpace($sourceApplication)
    for ($attempt = 1; $attempt -le 3 -and -not $sourceRestored; $attempt++) {
        try {
            Set-RevisionActive `
                -ApplicationName $sourceApplication `
                -Revision $sourceRevision `
                -Active $true
            $sourceRestored = -not [string]::IsNullOrWhiteSpace(
                (Get-ActiveRevision -ApplicationName $sourceApplication))
        }
        catch {
            Write-Warning "Source restoration attempt $attempt failed during rollback."
            Start-Sleep -Seconds 5
        }
    }
    if (-not $sourceRestored) {
        throw "Automatic rollback could not restore source application '$sourceApplication'."
    }

    if (-not $targetInactive) {
        try {
            $targetRevision = Get-ActiveRevision -ApplicationName $targetApplication
            Set-RevisionActive `
                -ApplicationName $targetApplication `
                -Revision $targetRevision `
                -Active $false
            $targetInactive = [string]::IsNullOrWhiteSpace(
                (Get-ActiveRevision -ApplicationName $targetApplication))
        }
        catch {
            Write-Warning "Target '$targetApplication' may still be active after source restoration."
        }
    }
    if ($targetInactive) {
        Remove-ContainerApp -ApplicationName $targetApplication
    }
    else {
        Write-Warning "Leaving target '$targetApplication' in place for manual recovery."
    }
    throw $deploymentFailure
}

if ($sourceApplication -ne $targetApplication) {
    Remove-ContainerApp -ApplicationName $sourceApplication
}
Remove-LegacyQdrantStorage

$deploymentResult = [pscustomobject]@{
    Application = $targetApplication
    BotUser = $status.botUser
    ImageTag = $imageTag
    ResourceGroup = $ResourceGroup
    SearchEndpoint = $foundation.searchEndpoint.value
    SubscriptionId = $SubscriptionId
    Url = $applicationUrl
}
}
finally {
    Exit-DeploymentLease -LeaseToken $deploymentLease
}

$deploymentResult | Format-List
