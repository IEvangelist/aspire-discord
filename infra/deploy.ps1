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

if ($StopLocalAppHost) {
    & aspire stop --apphost $appHostPath --non-interactive --nologo
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to stop the local AppHost before deployment.'
    }
}

$previous = @{
    SubscriptionId = $env:Azure__SubscriptionId
    ResourceGroup = $env:Azure__ResourceGroup
    Location = $env:Azure__Location
    ResourceSuffix = $env:Parameters__DeploymentResourceSuffix
    SkipBuild = $env:Parameters__DeploymentSkipBuild
}

try {
    $env:Azure__SubscriptionId = $SubscriptionId
    $env:Azure__ResourceGroup = $ResourceGroup
    $env:Azure__Location = $Location
    $env:Parameters__DeploymentResourceSuffix = $ResourceSuffix
    $env:Parameters__DeploymentSkipBuild = $SkipBuild.IsPresent.ToString().ToLowerInvariant()

    & aspire deploy `
        --apphost $appHostPath `
        --environment Production `
        --non-interactive `
        --nologo
    if ($LASTEXITCODE -ne 0) {
        throw 'Aspire deployment failed.'
    }
}
finally {
    $env:Azure__SubscriptionId = $previous.SubscriptionId
    $env:Azure__ResourceGroup = $previous.ResourceGroup
    $env:Azure__Location = $previous.Location
    $env:Parameters__DeploymentResourceSuffix = $previous.ResourceSuffix
    $env:Parameters__DeploymentSkipBuild = $previous.SkipBuild
}
