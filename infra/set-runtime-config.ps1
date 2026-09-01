[CmdletBinding()]
param(
    [string[]] $AddDiscordUserId = @(),
    [string[]] $RemoveDiscordUserId = @(),
    [switch] $AllowOpenAccess,
    [ValidateSet('collapsed', 'expanded', 'hidden')]
    [string] $GroundingDetailsMode,
    [string] $SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8',
    [string] $ResourceSuffix = 'ffccd7'
)

$ErrorActionPreference = 'Stop'
$storeName = "aspirediscord${ResourceSuffix}config"
$allowedUsersKey = 'AspireDiscord:Discord:AllowedUserIds'
$groundingModeKey = 'AspireDiscord:Discord:GroundingDetailsMode'

if ($AddDiscordUserId.Count -eq 0 `
    -and $RemoveDiscordUserId.Count -eq 0 `
    -and -not $AllowOpenAccess `
    -and -not $PSBoundParameters.ContainsKey('GroundingDetailsMode')) {
    throw 'Specify -AddDiscordUserId, -RemoveDiscordUserId, -AllowOpenAccess, or -GroundingDetailsMode.'
}

$requestedIds = @($AddDiscordUserId) + @($RemoveDiscordUserId)
foreach ($userId in $requestedIds) {
    if ($userId -notmatch '^\d+$') {
        throw "Discord user ID '$userId' must contain only digits."
    }
}
$conflictingIds = @($AddDiscordUserId | Where-Object { $_ -in $RemoveDiscordUserId })
if ($conflictingIds.Count -gt 0) {
    throw "The same Discord user ID cannot be added and removed: $($conflictingIds -join ', ')."
}
if ($AllowOpenAccess -and ($AddDiscordUserId.Count -gt 0 -or $RemoveDiscordUserId.Count -gt 0)) {
    throw '-AllowOpenAccess cannot be combined with adding or removing user IDs.'
}

if ($ResourceSuffix -notmatch '^[a-z0-9]{6,10}$') {
    throw 'ResourceSuffix must contain 6-10 lowercase letters or digits.'
}
$endpoint = "https://${storeName}.azconfig.io"

function Get-AppConfigToken {
    $output = @(& az account get-access-token `
        --subscription $SubscriptionId `
        --resource 'https://appconfig.azure.com' `
        --query accessToken `
        --output tsv)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) {
        throw 'Unable to acquire an Azure App Configuration token.'
    }
    return ($output | Select-Object -Last 1).Trim()
}

function Get-RuntimeSetting {
    param([string] $Key)

    $encodedKey = [Uri]::EscapeDataString($Key)
    $response = Invoke-WebRequest `
        -Uri "$endpoint/kv/${encodedKey}?api-version=1.0" `
        -Headers @{
            Accept = 'application/vnd.microsoft.appconfig.kv+json'
            Authorization = "Bearer $(Get-AppConfigToken)"
        } `
        -Method Get
    $setting = $response.Content | ConvertFrom-Json
    return [pscustomobject]@{
        ETag = [string]$setting.etag
        Value = [string]$setting.value
    }
}

function Set-RuntimeSetting {
    param(
        [string] $Key,
        [string] $Value,
        [string] $ETag
    )

    $encodedKey = [Uri]::EscapeDataString($Key)
    $quotedETag = "`"$($ETag.Trim('"'))`""
    try {
        Invoke-RestMethod `
            -Uri "$endpoint/kv/${encodedKey}?api-version=1.0" `
            -Headers @{
                Authorization = "Bearer $(Get-AppConfigToken)"
                'If-Match' = $quotedETag
            } `
            -Method Put `
            -ContentType 'application/vnd.microsoft.appconfig.kv+json' `
            -Body (@{ content_type = 'text/plain'; value = $Value } | ConvertTo-Json -Compress) |
            Out-Null
        return $true
    }
    catch {
        if ([int]$_.Exception.Response.StatusCode -eq 412) {
            return $false
        }
        throw
    }
}

function ConvertTo-DiscordUserList {
    param([string] $Value)

    $currentText = $Value.Trim()
    $currentIds = if (-not $currentText) {
        @()
    }
    elseif ($currentText.StartsWith('[')) {
        try {
            @($currentText | ConvertFrom-Json)
        }
        catch {
            throw 'The current Discord allowlist is not a valid JSON array.'
        }
    }
    else {
        @($currentText -split ',')
    }
    $users = [Collections.Generic.List[string]]::new()
    foreach ($userId in $currentIds) {
        if ($userId -isnot [string] -or $userId -notmatch '^\s*\d+\s*$') {
            throw 'The current Discord allowlist contains an invalid user ID.'
        }
        $trimmed = $userId.Trim()
        if (-not $users.Contains($trimmed)) {
            $users.Add($trimmed)
        }
    }
    return ,$users
}

function Update-DiscordAllowlist {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $setting = Get-RuntimeSetting -Key $allowedUsersKey
        $users = ConvertTo-DiscordUserList -Value $setting.Value
        $needsUpdate = $false
        foreach ($userId in $AddDiscordUserId) {
            if (-not $users.Contains($userId)) {
                $users.Add($userId)
                $needsUpdate = $true
            }
        }
        foreach ($userId in $RemoveDiscordUserId) {
            if ($users.Remove($userId)) {
                $needsUpdate = $true
            }
        }
        if ($AllowOpenAccess -and $users.Count -gt 0) {
            $users.Clear()
            $needsUpdate = $true
        }
        if ($users.Count -eq 0 -and -not $AllowOpenAccess) {
            throw 'Refusing to remove the final allowlisted user because an empty allowlist opens access. Use -AllowOpenAccess explicitly.'
        }
        if (-not $needsUpdate) {
            return $false
        }
        if (Set-RuntimeSetting -Key $allowedUsersKey -Value ($users -join ',') -ETag $setting.ETag) {
            return $true
        }
        Start-Sleep -Milliseconds (200 * $attempt)
    }
    throw 'The Discord allowlist changed concurrently too many times. Retry the command.'
}

function Update-GroundingMode {
    $normalizedMode = $GroundingDetailsMode.ToLowerInvariant()
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $setting = Get-RuntimeSetting -Key $groundingModeKey
        if ($setting.Value -ceq $normalizedMode) {
            return $false
        }
        if (Set-RuntimeSetting -Key $groundingModeKey -Value $normalizedMode -ETag $setting.ETag) {
            return $true
        }
        Start-Sleep -Milliseconds (200 * $attempt)
    }
    throw 'The grounding mode changed concurrently too many times. Retry the command.'
}

$changed = $false
if ($AddDiscordUserId.Count -gt 0 -or $RemoveDiscordUserId.Count -gt 0 -or $AllowOpenAccess) {
    $changed = Update-DiscordAllowlist
}
if ($PSBoundParameters.ContainsKey('GroundingDetailsMode')) {
    $changed = (Update-GroundingMode) -or $changed
}

if ($changed) {
    Write-Host 'Runtime configuration updated. The running bot will refresh it within 15 seconds.'
}
else {
    Write-Host 'Runtime configuration already matched the requested values.'
}
