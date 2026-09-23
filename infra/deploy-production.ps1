[CmdletBinding()]
param(
    [string] $SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8',
    [string] $ResourceGroup = 'aspire-discord-prod',
    [string] $Location = 'centralus',
    [string] $ResourceSuffix = 'ffccd7',
    [string] $ResultPath = '',
    [string] $CancellationPath = '',
    [switch] $SkipBuild,
    [switch] $UseExistingFoundation,
    [string] $GitHubIssuesAppId = '4968096',
    [string] $GitHubIssuesKeyId = '',
    [string] $GitHubIssuesInstallationId = '163850423',
    [switch] $StopLocalAppHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$appHostPath = Join-Path $repoRoot 'AspireDiscordBot.AppHost\apphost.mts'
$appTemplate = Join-Path $PSScriptRoot 'app.bicep'
$deploymentLeaseTag = 'AspireDiscordDeploymentLease'
. (Join-Path $PSScriptRoot 'existing-foundation.ps1') `
    -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup -Location $Location -ResourceSuffix $ResourceSuffix

if ($env:ASPIRE_DEPLOYMENT_PIPELINE -ne '1') {
    throw 'This implementation is owned by the Aspire pipeline. Run aspire deploy --environment Production.'
}
if ($GitHubIssuesKeyId -and (-not $UseExistingFoundation -or
    $GitHubIssuesKeyId -cnotmatch '^https://aspire-issues-ffccd7\.vault\.azure\.net/keys/github-issues/[a-f0-9]{32}$')) {
    throw 'Issue deployment requires existing foundation and an approved versioned GitHubIssuesKeyId.'
}
if (Test-Path Env:GITHUB_ISSUES_APP_PRIVATE_KEY) {
    throw 'Raw GitHub issue private keys are unsupported.'
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
    $parameters = @{
        location = @{ value = $Location }
        resourceSuffix = @{ value = $ResourceSuffix }
        environmentName = @{ value = 'production' }
        applicationName = @{ value = $ApplicationName }
        imageTag = @{ value = $imageTag }
        revisionSuffix = @{ value = $RevisionSuffix }
        enableDiscord = @{ value = $EnableDiscord }
        discordToken = @{ value = $discordToken }
        githubToken = @{ value = $githubToken }
        discordAllowedUserIds = @{ value = $allowedUserIds }
        githubIssuesAppId = @{ value = $GitHubIssuesAppId }
        githubIssuesKeyId = @{ value = $GitHubIssuesKeyId }
        githubIssuesInstallationId = @{ value = $GitHubIssuesInstallationId }
        githubIssuesTableEndpoint = @{ value = $githubIssuesTableEndpoint }
    }
    $parameterPath = New-DeploymentParameterFile -Parameters $parameters
    try {
        $json = @(& az deployment group create `
            --subscription $SubscriptionId `
            --resource-group $ResourceGroup `
            --name $DeploymentName `
            --mode Incremental `
            --template-file $appTemplate `
            --parameters "@$parameterPath" `
            --query properties.outputs `
            --only-show-errors `
            --output json 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        Remove-Item -LiteralPath (Split-Path -Parent $parameterPath) -Recurse -Force
    }
    Assert-DeploymentNotCancelled
    if ($exitCode -ne 0) {
        throw "Azure application deployment '$DeploymentName' failed."
    }
    return ($json -join "`n") | ConvertFrom-Json
}

function New-DeploymentParameterFile {
    param([hashtable] $Parameters)
    $directory = Join-Path $repoRoot "AspireDiscordBot.AppHost\.aspire\deployment-$([Guid]::NewGuid().ToString('N'))"
    try {
        if ($IsWindows) {
            New-Item -ItemType Directory -Path $directory | Out-Null
            $acl = Get-Acl -LiteralPath $directory
            $acl.SetAccessRuleProtection($true, $false)
            $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $owner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
            Set-Acl -LiteralPath $directory -AclObject $acl
        }
        else {
            [IO.Directory]::CreateDirectory($directory,
                [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute) | Out-Null
        }
        $path = Join-Path $directory 'parameters.json'
        @{ parameters = $Parameters } | ConvertTo-Json -Depth 10 -Compress |
            Set-Content -LiteralPath $path -Encoding utf8NoBOM
        return $path
    }
    catch {
        if (Test-Path -LiteralPath $directory) {
            Remove-Item -LiteralPath $directory -Recurse -Force
        }
        throw 'Unable to prepare protected deployment parameters.'
    }
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

function Invoke-StagedAzureCli {
    param([string[]] $Arguments)

    Assert-DeploymentNotCancelled
    $executable = (Get-Command az -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
    $prefix = @()
    if ($IsWindows -and $executable -like '*.cmd') {
        # Bypass cmd.exe so the Node expression arrives as one unchanged argument.
        $executable = Join-Path (Split-Path -Parent (Split-Path -Parent $executable)) 'python.exe'
        if (-not (Test-Path -LiteralPath $executable)) { throw 'Azure CLI Python executable was not found.' }
        $prefix = @('-X', 'utf8', '-IBm', 'azure.cli')
    }
    $start = [Diagnostics.ProcessStartInfo]::new($executable)
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @($prefix) + $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $started = $false
    try {
        $null = $process.Start()
        $started = $true
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(110)
        while (-not $process.WaitForExit(500)) {
            Assert-DeploymentNotCancelled
            if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Staged diagnostic CLI timed out.' }
        }
        Assert-DeploymentNotCancelled
        if ($process.ExitCode -ne 0) { throw 'Staged diagnostic CLI failed; output withheld.' }
        return $stdout.GetAwaiter().GetResult()
    }
    finally {
        if ($started -and -not $process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }
}

function Test-StagedFeatures {
    param([string] $ApplicationName, [string] $ExpectedRevision)

    Assert-DeploymentNotCancelled
    if ($ApplicationName -notin @('aspire-discord-blue', 'aspire-discord-green') -or
        $ApplicationName -eq $sourceApplication -or
        -not $ExpectedRevision.StartsWith("$ApplicationName--s-", [StringComparison]::Ordinal)) {
        throw 'Staged diagnostics must target the isolated staging slot and revision.'
    }
    $probePath = Join-Path $repoRoot 'infra\verify-staged-features.cjs'
    $payload = & node -e "process.stdout.write(require('node:zlib').brotliCompressSync(require('node:fs').readFileSync(process.argv[1])).toString('base64url'))" $probePath
    if ($LASTEXITCODE -ne 0 -or $payload -cnotmatch '^[A-Za-z0-9_-]+$') { throw 'Unable to encode staged diagnostic.' }
    $command = "node -e `"eval(require('node:zlib').brotliDecompressSync(Buffer.from('$payload','base64url')).toString())`""
    if ([Uri]::EscapeDataString($command).Length -gt 1800) { throw 'Staged diagnostic exceeds the console command limit.' }
    $scope = @('--subscription', $SubscriptionId, '--resource-group', $ResourceGroup, '--name', $ApplicationName)
    $revisionDeadline = [DateTimeOffset]::UtcNow.AddMinutes(4)
    while ($true) {
        $revisions = Invoke-StagedAzureCli -Arguments (@('containerapp', 'revision', 'list') + $scope + @('--output', 'json')) |
            ConvertFrom-Json
        $active = @($revisions | Where-Object { $_.properties.active })
        if ($active.Count -eq 1 -and $active[0].name -ceq $ExpectedRevision -and
            $active[0].properties.healthState -eq 'Healthy') { break }
        if (@($active | Where-Object {
            -not $_.name.StartsWith("$ApplicationName--s-", [StringComparison]::Ordinal)
        }).Count -gt 0) {
            throw 'Unexpected non-staging revision is active in the staging slot.'
        }
        if ([DateTimeOffset]::UtcNow -ge $revisionDeadline) {
            throw 'The expected staging revision did not become the sole active revision before the deadline.'
        }
        Assert-DeploymentNotCancelled
        Write-Host 'Waiting for the exact new staging revision; production remains active...'
        Start-Sleep -Seconds 5
    }
    $replicas = Invoke-StagedAzureCli -Arguments (@('containerapp', 'replica', 'list') + $scope +
        @('--revision', $ExpectedRevision, '--output', 'json')) | ConvertFrom-Json
    $replica = $replicas | Where-Object {
        @($_.properties.containers | Where-Object { $_.name -eq 'bot' -and $_.ready -eq $true }).Count -eq 1
    } | Select-Object -First 1
    if (-not $replica -or [string]::IsNullOrWhiteSpace($replica.name)) { throw 'No ready staged bot replica was found.' }
    Write-Host 'Checking staged GitHub reads and configured issue storage (read-only)...'
    $output = Invoke-StagedAzureCli -Arguments (@('containerapp', 'exec') + $scope +
        @('--revision', $ExpectedRevision, '--replica', $replica.name, '--container', 'bot', '--command', $command))
    # Azure exec can return zero even when the child fails. Never echo its captured content.
    # Windows CLI stdout can translate a remote CRLF into CRCRLF.
    if ($output.Replace("`r`r`n", "`r`n") -cnotmatch '(?m)^ASPIRE_STAGED_FEATURES_OK\r?$') {
        throw 'Staged feature checks failed; source remains active and diagnostic output is withheld.'
    }
    Write-Host 'ASPIRE_STAGED_FEATURES_OK'
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
    if ($UseExistingFoundation) {
        throw 'Existing production resource group is missing; no foundation deployment will be attempted.'
    }
    Invoke-AzureCli group create `
        --subscription $SubscriptionId `
        --name $ResourceGroup `
        --location $Location `
        --tags application=aspire-discord environment=production managedBy=bicep `
        --output none
}

if ($UseExistingFoundation) {
    $foundation = Get-ExistingFoundation -RequireIssueStorage:([bool]$GitHubIssuesKeyId)
}
$deploymentLease = Enter-DeploymentLease
try {
Assert-DeploymentNotCancelled
if (-not $UseExistingFoundation) {
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
}
$registryName = $foundation.registryName.value
$runtimeConfigName = $foundation.runtimeConfigName.value
$githubIssuesTableEndpoint = [string]$foundation.githubIssuesTableEndpoint.value

if (-not $SkipBuild) {
    $buildContext = Join-Path $repoRoot "AspireDiscordBot.AppHost\.aspire\build-$runId-$PID"
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
if ($GitHubIssuesKeyId) {
    Test-StagedFeatures -ApplicationName $targetApplication `
        -ExpectedRevision "$targetApplication--s-$($imageTag.Substring(0, 7))-$runId"
}

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
if (-not $UseExistingFoundation) {
    Remove-LegacyQdrantStorage -IgnoreCancellation
}

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
