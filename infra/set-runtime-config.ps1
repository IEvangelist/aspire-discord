[CmdletBinding()]
param(
    [string[]] $AddDiscordUserId = @(),
    [string[]] $RemoveDiscordUserId = @(),
    [switch] $AllowOpenAccess,
    [ValidateSet('collapsed', 'expanded', 'hidden')]
    [string] $GroundingDetailsMode,
    [string] $IssuePolicyJson,
    [string] $SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8',
    [string] $ResourceSuffix = 'ffccd7'
)

$ErrorActionPreference = 'Stop'
$storeName = "aspirediscord${ResourceSuffix}config"
$allowedUsersKey = 'AspireDiscord:Discord:AllowedUserIds'
$groundingModeKey = 'AspireDiscord:Discord:GroundingDetailsMode'
$issuePolicyKey = 'AspireDiscord:Discord:IssuePolicy'

if ($AddDiscordUserId.Count -eq 0 `
    -and $RemoveDiscordUserId.Count -eq 0 `
    -and -not $AllowOpenAccess `
    -and -not $PSBoundParameters.ContainsKey('GroundingDetailsMode') `
    -and -not $PSBoundParameters.ContainsKey('IssuePolicyJson')) {
    throw 'Specify -AddDiscordUserId, -RemoveDiscordUserId, -AllowOpenAccess, -GroundingDetailsMode, or -IssuePolicyJson.'
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
    param([string] $Key, [switch] $AllowMissing)

    $encodedKey = [Uri]::EscapeDataString($Key)
    try {
        $response = Invoke-WebRequest `
        -Uri "$endpoint/kv/${encodedKey}?api-version=1.0" `
        -Headers @{
            Accept = 'application/vnd.microsoft.appconfig.kv+json'
            Authorization = "Bearer $(Get-AppConfigToken)"
        } `
            -Method Get
    }
    catch {
        if ($AllowMissing -and [int]$_.Exception.Response.StatusCode -eq 404) {
            return $null
        }
        throw
    }
    $content = if ($response.Content -is [byte[]]) {
        [Text.Encoding]::UTF8.GetString($response.Content)
    }
    else {
        [string]$response.Content
    }
    $setting = ConvertFrom-Json -InputObject $content
    return [pscustomobject]@{
        ETag = [string]$response.Headers.ETag
        Value = [string]$setting.value
    }
}

function Set-RuntimeSetting {
    param(
        [string] $Key,
        [string] $Value,
        [string] $ETag,
        [switch] $CreateIfMissing,
        [string] $ContentType = 'text/plain'
    )

    $encodedKey = [Uri]::EscapeDataString($Key)
    $quotedETag = "`"$($ETag.Trim('"'))`""
    $condition = if ($CreateIfMissing) { 'If-None-Match' } else { 'If-Match' }
    $conditionValue = if ($CreateIfMissing) { '*' } else { $quotedETag }
    try {
        Invoke-RestMethod `
            -Uri "$endpoint/kv/${encodedKey}?api-version=1.0" `
            -Headers @{
                Authorization = "Bearer $(Get-AppConfigToken)"
                $condition = $conditionValue
            } `
            -Method Put `
            -ContentType 'application/vnd.microsoft.appconfig.kv+json' `
            -Body ([Text.Encoding]::UTF8.GetBytes(
                (@{ content_type = $ContentType; value = $Value } | ConvertTo-Json -Compress))) |
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

function ConvertTo-IssuePolicyJson {
    param([string] $Value)

    try {
        $document = [Text.Json.JsonDocument]::Parse($Value)
    }
    catch {
        throw 'IssuePolicyJson must be a JSON object.'
    }
    try {
        $root = $document.RootElement
        if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Object) {
            throw 'IssuePolicyJson must be a JSON object.'
        }
        $keys = @('enabled', 'allowedUserIds', 'allowedChannelIds', 'allowedRepositories')
        $allowedKeys = $keys + @('allowedGuildIds')
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $root.EnumerateObject()) {
            if ($allowedKeys -cnotcontains $property.Name -or -not $seen.Add($property.Name)) {
                throw 'IssuePolicyJson contains an unknown or duplicate property.'
            }
        }
        if (@($keys | Where-Object { -not $seen.Contains($_) }).Count -gt 0 -or $root.GetProperty('enabled').ValueKind -notin @(
            [Text.Json.JsonValueKind]::True, [Text.Json.JsonValueKind]::False)) {
            throw 'IssuePolicyJson requires enabled (boolean), allowedUserIds, allowedChannelIds, and allowedRepositories.'
        }
        $policy = [ordered]@{ enabled = $root.GetProperty('enabled').GetBoolean() }
        foreach ($key in $allowedKeys | Select-Object -Skip 1) {
            if (-not $seen.Contains($key)) { continue }
            $array = $root.GetProperty($key)
            if ($array.ValueKind -ne [Text.Json.JsonValueKind]::Array) {
                throw "IssuePolicyJson $key must be an array of strings."
            }
            $maximum = if ($key -eq 'allowedRepositories') { 20 } else { 500 }
            if ($array.GetArrayLength() -gt $maximum) {
                throw "IssuePolicyJson $key cannot contain more than $maximum entries."
            }
            $values = [Collections.Generic.List[string]]::new()
            foreach ($item in $array.EnumerateArray()) {
                if ($item.ValueKind -ne [Text.Json.JsonValueKind]::String) {
                    throw "IssuePolicyJson $key must contain only strings."
                }
                $entry = $item.GetString().Trim()
                if ($key -eq 'allowedRepositories') {
                    $entry = $entry.ToLowerInvariant()
                    if ($entry -notmatch '^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9._-]{1,100}$' `
                        -or ($entry -split '/')[1] -in @('.', '..')) {
                        throw 'IssuePolicyJson repositories must use canonical owner/repo names, not URLs.'
                    }
                }
                elseif ($entry -notmatch '^[1-9][0-9]*$') {
                    throw "IssuePolicyJson $key must contain positive Discord ID strings."
                }
                if (-not $values.Contains($entry)) {
                    $values.Add($entry)
                }
            }
            if ($policy.enabled -and $key -in @('allowedUserIds', 'allowedRepositories') -and $values.Count -eq 0) {
                throw "IssuePolicyJson $key must not be empty when enabled."
            }
            $policy[$key] = @($values.ToArray())
        }
        if ($policy.enabled -and $policy.allowedChannelIds.Count -eq 0 -and
            (-not $seen.Contains('allowedGuildIds') -or $policy.allowedGuildIds.Count -eq 0)) {
            throw 'IssuePolicyJson requires at least one explicit channel or server when enabled.'
        }
        return $policy | ConvertTo-Json -Depth 5 -Compress
    }
    finally {
        $document.Dispose()
    }
}

function Update-IssuePolicy {
    param([string] $Value)

    $setting = Get-RuntimeSetting -Key $issuePolicyKey -AllowMissing
    if ($null -ne $setting -and $setting.Value -ceq $Value) {
        return $false
    }
    $etag = if ($null -eq $setting) { '' } else { $setting.ETag }
    if (-not (Set-RuntimeSetting -Key $issuePolicyKey -Value $Value -ETag $etag `
        -CreateIfMissing:($null -eq $setting) -ContentType 'application/json')) {
        throw 'The issue policy changed concurrently. Review it and retry the command.'
    }
    return $true
}

$normalizedIssuePolicy = if ($PSBoundParameters.ContainsKey('IssuePolicyJson')) {
    ConvertTo-IssuePolicyJson -Value $IssuePolicyJson
}

$changed = $false
if ($AddDiscordUserId.Count -gt 0 -or $RemoveDiscordUserId.Count -gt 0 -or $AllowOpenAccess) {
    $changed = Update-DiscordAllowlist
}
if ($PSBoundParameters.ContainsKey('GroundingDetailsMode')) {
    $changed = (Update-GroundingMode) -or $changed
}
if ($PSBoundParameters.ContainsKey('IssuePolicyJson')) {
    $changed = (Update-IssuePolicy -Value $normalizedIssuePolicy) -or $changed
}

if ($changed) {
    Write-Host 'Runtime configuration updated. The running bot will refresh it within 15 seconds.'
}
else {
    Write-Host 'Runtime configuration already matched the requested values.'
}
