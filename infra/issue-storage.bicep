@description('Azure region for the issue draft store.')
param location string

param storageAccountName string = 'aspireissuesffccd7'
param managedIdentityName string = 'aspire-discord-production-id'
param managedIdentityPrincipalId string = '16d6bfa3-79e5-4da5-b2d8-b76672588040'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: managedIdentityName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: {
    application: 'aspire-discord'
    environment: 'production'
    managedBy: 'aspire'
    purpose: 'issue-drafts'
  }
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource drafts 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tables
  name: 'IssueDrafts'
}

resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: drafts
  name: guid(drafts.id, managedIdentityPrincipalId, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  properties: {
    principalId: toLower(identity.properties.principalId) == toLower(managedIdentityPrincipalId) ? managedIdentityPrincipalId : ''
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  }
}

output tableEndpoint string = storage.properties.primaryEndpoints.table
output tableName string = drafts.name
output roleScope string = drafts.id
