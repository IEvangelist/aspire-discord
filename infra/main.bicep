@description('Azure region for all deployment resources.')
param location string = 'centralus'

@description('Deterministic suffix used by globally unique resource names.')
@minLength(6)
@maxLength(10)
param resourceSuffix string

@description('Deployment environment tag.')
param environmentName string = 'production'

@description('Optional deployment principal granted Search data-plane access for validation.')
param deploymentPrincipalId string = ''

@allowed([
  'Group'
  'ServicePrincipal'
  'User'
])
@description('Type of the optional deployment principal.')
param deploymentPrincipalType string = 'User'

@description('Optional operator principal granted access to edit live runtime configuration.')
param runtimeConfigEditorPrincipalId string = ''

@allowed([
  'Group'
  'ServicePrincipal'
  'User'
])
@description('Type of the optional runtime configuration editor principal.')
param runtimeConfigEditorPrincipalType string = 'User'

var baseName = 'aspire-discord-${environmentName}'
var compactName = 'aspirediscord${resourceSuffix}'
var tags = {
  application: 'aspire-discord'
  environment: environmentName
  managedBy: 'bicep'
}
var containerSubnetName = 'container-apps'
var containerSubnetId = resourceId(
  'Microsoft.Network/virtualNetworks/subnets',
  virtualNetwork.name,
  containerSubnetName
)

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var openAiUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)
var searchDataReaderRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '1407120a-92aa-4202-b7e9-c0e197c71c8f'
)
var searchDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
)
var searchServiceContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
)
var monitoringMetricsPublisherRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)
var appConfigurationDataReaderRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '516239f1-63e1-4d78-a4de-a74fb236a071'
)
var appConfigurationDataOwnerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b'
)

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${baseName}-id'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: compactName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource runtimeConfig 'Microsoft.AppConfiguration/configurationStores@2024-06-01' = {
  name: '${compactName}config'
  location: location
  tags: tags
  sku: {
    name: 'standard'
  }
  properties: {
    dataPlaneProxy: {
      authenticationMode: 'Pass-through'
      privateLinkDelegation: 'Disabled'
    }
    defaultKeyValueRevisionRetentionPeriodInSeconds: 2592000
    disableLocalAuth: true
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    softDeleteRetentionInDays: 30
  }
}

resource runtimeConfigReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(runtimeConfig.id, identity.id, appConfigurationDataReaderRoleDefinitionId)
  scope: runtimeConfig
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: appConfigurationDataReaderRoleDefinitionId
  }
}

resource deploymentRuntimeConfigOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(runtimeConfigEditorPrincipalId)) {
  name: guid(runtimeConfig.id, runtimeConfigEditorPrincipalId, appConfigurationDataOwnerRoleDefinitionId)
  scope: runtimeConfig
  properties: {
    principalId: runtimeConfigEditorPrincipalId
    principalType: runtimeConfigEditorPrincipalType
    roleDefinitionId: appConfigurationDataOwnerRoleDefinitionId
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${baseName}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: containerSubnetName
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          serviceEndpoints: [
            {
              locations: [
                location
              ]
              service: 'Microsoft.Storage'
            }
          ]
        }
      }
    ]
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${baseName}-logs'
  location: location
  tags: tags
  properties: {
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${baseName}-insights'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    WorkspaceResourceId: logs.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource applicationInsightsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsights.id, identity.id, monitoringMetricsPublisherRoleDefinitionId)
  scope: applicationInsights
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: '${baseName}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'aspire-discord-ai-${resourceSuffix}'
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'aspire-discord-ai-${resourceSuffix}'
    disableLocalAuth: true
    networkAcls: {
      defaultAction: 'Allow'
    }
    publicNetworkAccess: 'Enabled'
  }
}

resource foundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identity.id, openAiUserRoleDefinitionId)
  scope: foundry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: openAiUserRoleDefinitionId
  }
}

resource chatDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'gpt-5.6-sol'
  sku: {
    name: 'GlobalStandard'
    capacity: 100
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.6-sol'
      version: '2026-07-09'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'text-embedding-3-small'
  sku: {
    name: 'GlobalStandard'
    capacity: 500
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-small'
      version: '1'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
  dependsOn: [
    chatDeployment
  ]
}

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: 'aspire-discord-search-${resourceSuffix}'
  location: location
  tags: tags
  sku: {
    name: 'basic'
  }
  properties: {
    disableLocalAuth: true
    hostingMode: 'Default'
    networkRuleSet: {
      bypass: 'None'
      ipRules: []
    }
    partitionCount: 1
    publicNetworkAccess: 'enabled'
    replicaCount: 1
    semanticSearch: 'free'
  }
}

resource searchDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, identity.id, searchDataReaderRoleDefinitionId)
  scope: search
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: searchDataReaderRoleDefinitionId
  }
}

resource searchDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, identity.id, searchDataContributorRoleDefinitionId)
  scope: search
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: searchDataContributorRoleDefinitionId
  }
}

resource searchServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, identity.id, searchServiceContributorRoleDefinitionId)
  scope: search
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: searchServiceContributorRoleDefinitionId
  }
}

resource deploymentSearchDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deploymentPrincipalId)) {
  name: guid(search.id, deploymentPrincipalId, searchDataReaderRoleDefinitionId)
  scope: search
  properties: {
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
    roleDefinitionId: searchDataReaderRoleDefinitionId
  }
}

resource deploymentSearchDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deploymentPrincipalId)) {
  name: guid(search.id, deploymentPrincipalId, searchDataContributorRoleDefinitionId)
  scope: search
  properties: {
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
    roleDefinitionId: searchDataContributorRoleDefinitionId
  }
}

resource deploymentSearchServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deploymentPrincipalId)) {
  name: guid(search.id, deploymentPrincipalId, searchServiceContributorRoleDefinitionId)
  scope: search
  properties: {
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
    roleDefinitionId: searchServiceContributorRoleDefinitionId
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output runtimeConfigEndpoint string = 'https://${runtimeConfig.name}.azconfig.io'
output runtimeConfigName string = runtimeConfig.name
output applicationInsightsName string = applicationInsights.name
output containerEnvironmentName string = containerEnvironment.name
output foundryEndpoint string = foundry.properties.endpoint
output foundryName string = foundry.name
output identityClientId string = identity.properties.clientId
output identityName string = identity.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
output searchName string = search.name
output virtualNetworkName string = virtualNetwork.name
