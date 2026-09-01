[CmdletBinding()]
param(
    [string] $SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8',
    [string] $ResourceGroup = 'aspire-discord-prod',
    [string] $Location = 'centralus',
    [string] $ResourceSuffix = 'ffccd7',
    [string] $ResultPath = '',
    [string] $CancellationPath = '',
    [switch] $SkipBuild,
    [switch] $StopLocalAppHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$appHostPath = Join-Path $repoRoot 'AspireDiscordBot.AppHost\apphost.mts'
$appTemplate = Join-Path $PSScriptRoot 'app.bicep'
$deploymentLeaseTag = 'AspireDiscordDeploymentLease'

if ($env:ASPIRE_DEPLOYMENT_PIPELINE -ne '1') {
    throw 'This implementation is owned by the Aspire pipeline. Run aspire deploy --environment Production.'
}

function Assert-DeploymentNotCancelled {
    if (-not [string]::IsNullOrWhiteSpace($CancellationPath) `
        -and (Test-Path -LiteralPath $CancellationPath)) {
        throw [OperationCanceledException]::new('Aspire deployment was cancelled.')
    }
}

function Invoke-AzureCli {
    param(
        [switch] $IgnoreCancellation,
        [Parameter(ValueFromRemainingArguments)][string[]] $Arguments
    )

    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    & az @Arguments
    $exitCode = $LASTEXITCODE
    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    if ($exitCode -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')"
    }
}

function Get-DeploymentSecret {
    param(
        [string] $EnvironmentName,
        [string] $AspireKey,
        [switch] $Optional
    )

    Assert-DeploymentNotCancelled
    $value = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if ([string]::IsNullOrWhiteSpace($value)) {
        $output = @(& aspire secret get $AspireKey --apphost $appHostPath --non-interactive --nologo 2>$null)
        $exitCode = $LASTEXITCODE
        Assert-DeploymentNotCancelled
        if ($exitCode -eq 0) {
            $value = ($output | Select-Object -Last 1).Trim()
        }
    }
    if ([string]::IsNullOrWhiteSpace($value) -and -not $Optional) {
        throw "Set $EnvironmentName or configure Aspire secret '$AspireKey'."
    }
    return $value
}

function Get-ManagementToken {
    param([switch] $IgnoreCancellation)

    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    $token = & az account get-access-token `
        --subscription $SubscriptionId `
        --resource 'https://management.azure.com/' `
        --query accessToken `
        --output tsv
    $exitCode = $LASTEXITCODE
    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw 'Unable to acquire an Azure Resource Manager token for the deployment lease.'
    }
    return $token.Trim()
}

function Get-AppConfigToken {
    Assert-DeploymentNotCancelled
    $token = & az account get-access-token `
        --subscription $SubscriptionId `
        --resource 'https://appconfig.azure.com' `
        --query accessToken `
        --output tsv
    $exitCode = $LASTEXITCODE
    Assert-DeploymentNotCancelled
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw 'Unable to acquire an Azure App Configuration token.'
    }
    return $token.Trim()
}

function Get-DeploymentPrincipal {
    Assert-DeploymentNotCancelled
    $accountJson = & az account show `
        --subscription $SubscriptionId `
        --query user `
        --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accountJson)) {
        Write-Warning 'Could not resolve the deployment principal; runtime configuration editing access was not assigned.'
        return [pscustomobject]@{ Id = ''; Type = 'User' }
    }

    $account = $accountJson | ConvertFrom-Json
    $principalType = if ($account.type -eq 'servicePrincipal') {
        'ServicePrincipal'
    }
    else {
        'User'
    }
    $principalId = ''
    try {
        $token = Get-ManagementToken
        $encodedPayload = $token.Split('.')[1].Replace('-', '+').Replace('_', '/')
        $padding = (4 - ($encodedPayload.Length % 4)) % 4
        $encodedPayload += '=' * $padding
        $claims = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($encodedPayload)) | ConvertFrom-Json
        $principalId = [string]$claims.oid
    }
    catch {
        Write-Warning 'Could not read the deployment principal from the Azure access token.'
    }

    if ([string]::IsNullOrWhiteSpace($principalId)) {
        Write-Warning 'Could not resolve the deployment principal object ID; runtime configuration editing access was not assigned.'
        return [pscustomobject]@{ Id = ''; Type = $principalType }
    }
    return [pscustomobject]@{ Id = $principalId; Type = $principalType }
}

function Initialize-RuntimeConfigSetting {
    param(
        [string] $StoreName,
        [string] $Key,
        [string] $Value
    )

    $encodedKey = [Uri]::EscapeDataString($Key)
    $uri = "https://${StoreName}.azconfig.io/kv/${encodedKey}?api-version=1.0"
    $body = @{
        content_type = 'text/plain'
        value = $Value
    } | ConvertTo-Json -Compress
    for ($attempt = 1; $attempt -le 90; $attempt++) {
        Assert-DeploymentNotCancelled
        $appConfigToken = Get-AppConfigToken
        try {
            Invoke-RestMethod `
                -Uri $uri `
                -Headers @{
                    Authorization = "Bearer $appConfigToken"
                    'If-None-Match' = '*'
                } `
                -Method Put `
                -ContentType 'application/vnd.microsoft.appconfig.kv+json' `
                -Body $body | Out-Null
            return
        }
        catch {
            $statusCode = [int]$_.Exception.Response.StatusCode
            if ($statusCode -eq 412) {
                return
            }
            if ($statusCode -notin @(401, 403, 429) -or $attempt -eq 90) {
                throw
            }
            if ($attempt -eq 1 -or $attempt % 6 -eq 0) {
                Write-Host 'Waiting for Azure App Configuration data access to propagate...'
            }
            Start-Sleep -Seconds 10
        }
    }
    throw "Azure App Configuration setting '$Key' could not be initialized."
}

function Initialize-RuntimeConfig {
    param(
        [string] $StoreName,
        [string] $AllowedUserIds
    )

    Initialize-RuntimeConfigSetting `
        -StoreName $StoreName `
        -Key 'AspireDiscord:Discord:AllowedUserIds' `
        -Value $AllowedUserIds
    Initialize-RuntimeConfigSetting `
        -StoreName $StoreName `
        -Key 'AspireDiscord:Discord:GroundingDetailsMode' `
        -Value 'collapsed'
}

function Enter-DeploymentLease {
    $uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourcegroups/${ResourceGroup}?api-version=2024-03-01"
    $leaseToken = [Guid]::NewGuid().ToString('N')
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        Assert-DeploymentNotCancelled
        $managementToken = Get-ManagementToken
        $headers = @{ Authorization = "Bearer $managementToken" }
        $response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get
        Assert-DeploymentNotCancelled
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
            $managementToken = Get-ManagementToken -IgnoreCancellation
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

    Assert-DeploymentNotCancelled
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
    $exitCode = $LASTEXITCODE
    Assert-DeploymentNotCancelled
    if ($exitCode -ne 0) {
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
        Assert-DeploymentNotCancelled
        try {
            $ready = Invoke-RestMethod -Uri "$ApplicationUrl/ready" -TimeoutSec 15
            $status = Invoke-RestMethod -Uri "$ApplicationUrl/status" -TimeoutSec 15
            Assert-DeploymentNotCancelled
            $expectedState = if ($ExpectDiscord) { 'ready' } else { 'disabled' }
            if ($ready.ready -eq $true -and $status.state -eq $expectedState) {
                return $status
            }
        }
        catch {
            Assert-DeploymentNotCancelled
            Write-Host "Waiting for $ApplicationUrl ..."
        }
        Start-Sleep -Seconds 20
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Container App at '$ApplicationUrl' did not reach the expected state."
}

function Get-ActiveRevision {
    param(
        [string] $ApplicationName,
        [switch] $IgnoreCancellation
    )

    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    $revision = & az containerapp revision list `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --query '[?properties.active].name | [0]' `
        --output tsv 2>$null
    $exitCode = $LASTEXITCODE
    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    if ($exitCode -eq 0) {
        if ($null -eq $revision) {
            return ''
        }
        return ([string]$revision).Trim()
    }
    throw "Unable to inspect active revisions for Container App '$ApplicationName'."
}

function Set-RevisionActive {
    param(
        [string] $ApplicationName,
        [string] $Revision,
        [bool] $Active,
        [switch] $IgnoreCancellation
    )

    if ([string]::IsNullOrWhiteSpace($Revision)) {
        return
    }
    $command = if ($Active) { 'activate' } else { 'deactivate' }
    Invoke-AzureCli -IgnoreCancellation:$IgnoreCancellation containerapp revision $command `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --revision $Revision `
        --output none
}

function Get-SourceApplication {
    Assert-DeploymentNotCancelled
    $json = & az containerapp list `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --output json
    $exitCode = $LASTEXITCODE
    Assert-DeploymentNotCancelled
    if ($exitCode -ne 0) {
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
    param(
        [string] $ApplicationName,
        [switch] $IgnoreCancellation
    )

    if ([string]::IsNullOrWhiteSpace($ApplicationName)) {
        return
    }

    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    $json = & az containerapp show `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $ApplicationName `
        --output json 2>$null
    $exitCode = $LASTEXITCODE
    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    if ($exitCode -ne 0) {
        Write-Warning "Could not inspect superseded Container App '$ApplicationName'."
        return
    }
    $application = $json | ConvertFrom-Json
    if ($application.tags.application -ne 'aspire-discord' `
        -or $application.tags.managedBy -ne 'bicep') {
        Write-Warning "Refusing to remove unowned Container App '$ApplicationName'."
        return
    }
    $revisionStatusVerified = $false
    $activeRevision = ''
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        try {
        $activeRevision = Get-ActiveRevision `
            -ApplicationName $ApplicationName `
            -IgnoreCancellation:$IgnoreCancellation
        $revisionStatusVerified = $true
        if ([string]::IsNullOrWhiteSpace($activeRevision)) {
            break
        }
        }
        catch {
        $revisionStatusVerified = $false
        }
        Start-Sleep -Seconds 5
    }
    if (-not $revisionStatusVerified) {
        Write-Warning "Cannot verify revision status for '$ApplicationName'; refusing to remove it."
        return
    }
    if (-not [string]::IsNullOrWhiteSpace($activeRevision)) {
        Write-Warning "Refusing to remove active Container App '$ApplicationName'."
        return
    }

    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
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
    param([switch] $IgnoreCancellation)

    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    & az containerapp env storage remove `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name 'aspire-discord-production-env' `
        --storage-name 'qdrant-storage' `
        --yes `
        --output none 2>$null

    $storageName = "aspirediscord$ResourceSuffix"
    if (-not $IgnoreCancellation) {
        Assert-DeploymentNotCancelled
    }
    & az storage account show `
        --subscription $SubscriptionId `
        --resource-group $ResourceGroup `
        --name $storageName `
        --output none 2>$null
    if ($LASTEXITCODE -eq 0) {
        if (-not $IgnoreCancellation) {
            Assert-DeploymentNotCancelled
        }
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
Assert-DeploymentNotCancelled
if (git status --porcelain) {
    throw 'Commit the deployment source before building immutable images.'
}

$imageTag = (git rev-parse --short=12 HEAD).Trim()
Assert-DeploymentNotCancelled
$runId = Get-Date -Format 'yyMMddHHmmss'

Invoke-AzureCli account show --subscription $SubscriptionId --output none
Assert-DeploymentNotCancelled
$resourceGroupExists = & az group exists `
    --subscription $SubscriptionId `
    --name $ResourceGroup `
    --output tsv
$exitCode = $LASTEXITCODE
Assert-DeploymentNotCancelled
if ($exitCode -ne 0) {
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
Assert-DeploymentNotCancelled
$deploymentPrincipal = Get-DeploymentPrincipal
$foundationParameters = @(
    "location=$Location"
    "resourceSuffix=$ResourceSuffix"
    'environmentName=production'
)
if (-not [string]::IsNullOrWhiteSpace($deploymentPrincipal.Id)) {
    $foundationParameters += "runtimeConfigEditorPrincipalId=$($deploymentPrincipal.Id)"
    $foundationParameters += "runtimeConfigEditorPrincipalType=$($deploymentPrincipal.Type)"
}
$foundationJson = & az deployment group create `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --name "foundation-$runId" `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters $foundationParameters `
    --query properties.outputs `
    --output json
$exitCode = $LASTEXITCODE
Assert-DeploymentNotCancelled
if ($exitCode -ne 0) {
    throw 'Azure foundation deployment failed.'
}
$foundation = $foundationJson | ConvertFrom-Json
$registryName = $foundation.registryName.value
$runtimeConfigName = $foundation.runtimeConfigName.value

if (-not $SkipBuild) {
    $buildContext = Join-Path ([IO.Path]::GetTempPath()) "aspire-discord-build-$runId-$PID"
    $archivePath = "$buildContext.tar"
    try {
        New-Item -ItemType Directory -Path $buildContext | Out-Null
        Assert-DeploymentNotCancelled
        & git archive --format=tar --output=$archivePath HEAD
        $exitCode = $LASTEXITCODE
        Assert-DeploymentNotCancelled
        if ($exitCode -ne 0) {
            throw 'Unable to create the immutable Git build context.'
        }
        & tar -xf $archivePath -C $buildContext
        $exitCode = $LASTEXITCODE
        Assert-DeploymentNotCancelled
        if ($exitCode -ne 0) {
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

Initialize-RuntimeConfig `
    -StoreName $runtimeConfigName `
    -AllowedUserIds $allowedUserIds

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
    Assert-DeploymentNotCancelled
    & aspire stop --apphost $appHostPath --non-interactive --nologo
    $exitCode = $LASTEXITCODE
    Assert-DeploymentNotCancelled
    if ($exitCode -ne 0) {
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
try {
    Set-RevisionActive `
        -ApplicationName $sourceApplication `
        -Revision $sourceRevision `
        -Active $false
    Assert-DeploymentNotCancelled

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
            $targetRevision = Get-ActiveRevision `
                -ApplicationName $targetApplication `
                -IgnoreCancellation
            Set-RevisionActive `
                -ApplicationName $targetApplication `
                -Revision $targetRevision `
                -Active $false `
                -IgnoreCancellation
            $targetInactive = [string]::IsNullOrWhiteSpace(
                (Get-ActiveRevision `
                    -ApplicationName $targetApplication `
                    -IgnoreCancellation))
        }
        catch {
            Write-Warning "Target deactivation attempt $attempt failed during rollback."
            Start-Sleep -Seconds 5
        }
    }
    if (-not $targetInactive) {
        throw [InvalidOperationException]::new(
            "Target '$targetApplication' could not be confirmed inactive. " +
            "The source bot was not reactivated because that could run two bots with the same token. " +
            "Manual intervention is required.",
            $deploymentFailure.Exception)
    }

    $sourceRestored = [string]::IsNullOrWhiteSpace($sourceApplication) `
        -or -not [string]::IsNullOrWhiteSpace(
            (Get-ActiveRevision `
                -ApplicationName $sourceApplication `
                -IgnoreCancellation))
    for ($attempt = 1; $attempt -le 3 -and -not $sourceRestored; $attempt++) {
        try {
            Set-RevisionActive `
                -ApplicationName $sourceApplication `
                -Revision $sourceRevision `
                -Active $true `
                -IgnoreCancellation
            $sourceRestored = -not [string]::IsNullOrWhiteSpace(
                (Get-ActiveRevision `
                    -ApplicationName $sourceApplication `
                    -IgnoreCancellation))
        }
        catch {
            Write-Warning "Source restoration attempt $attempt failed during rollback."
            Start-Sleep -Seconds 5
        }
    }
    if (-not $sourceRestored) {
        throw "Automatic rollback could not restore source application '$sourceApplication'."
    }

    Remove-ContainerApp `
        -ApplicationName $targetApplication `
        -IgnoreCancellation
    throw $deploymentFailure
}

if ($sourceApplication -ne $targetApplication) {
    Remove-ContainerApp `
        -ApplicationName $sourceApplication `
        -IgnoreCancellation
}
Remove-LegacyQdrantStorage -IgnoreCancellation

$deploymentResult = [pscustomobject]@{
    Application = $targetApplication
    BotUser = $status.botUser
    ImageTag = $imageTag
    ResourceGroup = $ResourceGroup
    SearchEndpoint = $foundation.searchEndpoint.value
    SubscriptionId = $SubscriptionId
    Url = $applicationUrl
}
if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    $resultDirectory = Split-Path -Parent $ResultPath
    if (-not [string]::IsNullOrWhiteSpace($resultDirectory)) {
        New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    }
    $deploymentResult |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath $ResultPath -Encoding utf8NoBOM
}
}
finally {
    Exit-DeploymentLease -LeaseToken $deploymentLease
}

$deploymentResult | Format-List
