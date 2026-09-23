// Aspire supplies location to every Azure Bicep module, including locationless RBAC resources.
#disable-next-line no-unused-params
param location string = resourceGroup().location

@minLength(3)
@maxLength(24)
param vaultName string

@minLength(1)
@maxLength(127)
param keyName string

@minLength(3)
@maxLength(128)
param managedIdentityName string

@description('Preflight-verified managed identity object ID, never its client/application ID.')
@minLength(36)
@maxLength(36)
param expectedPrincipalId string

@allowed([
  'custom-sign-only'
  'builtin-key-scoped'
])
@description('Crypto User also permits key read/update/backup and other crypto operations; this is NOT sign-only.')
param roleMode string = 'custom-sign-only'

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

resource signingKey 'Microsoft.KeyVault/vaults/keys@2024-11-01' existing = {
  parent: vault
  name: keyName
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: managedIdentityName
}

resource signingRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (roleMode == 'custom-sign-only') {
  name: guid(toLower(resourceGroup().id), toLower(vault.name), 'aspire-discord-issue-key-sign-only')
  properties: {
    roleName: 'Aspire issue signing (${resourceGroup().name}/${vault.name})'
    description: 'Sign only; assign to the dedicated GitHub App key, never to the vault or resource group.'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.KeyVault/vaults/keys/sign/action'
        ]
        notDataActions: []
      }
    ]
  }
}

var signingRoleId = roleMode == 'builtin-key-scoped'
  ? subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')
  : signingRole!.id

resource signingAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(toLower(signingKey.id), toLower(expectedPrincipalId), signingRoleId)
  scope: signingKey
  properties: {
    // Fail ARM validation instead of granting a recreated identity if it changed after preflight.
    principalId: toLower(runtimeIdentity.properties.principalId) == toLower(expectedPrincipalId) ? expectedPrincipalId : ''
    principalType: 'ServicePrincipal'
    roleDefinitionId: signingRoleId
    description: roleMode == 'builtin-key-scoped'
      ? 'Approved Crypto User (not sign-only); dedicated GitHub App key only, across its versions.'
      : 'Aspire Discord GitHub App signing; this key only, across its versions.'
  }
}

output keyResourceId string = signingKey.id
output roleDefinitionId string = signingRoleId
output assignmentId string = signingAssignment.id
