@description('Azure region for the Container App.')
param location string = resourceGroup().location

@description('Deterministic suffix used by globally unique resource names.')
param resourceSuffix string

@description('Deployment environment tag.')
param environmentName string = 'production'

@description('Immutable container image tag.')
param imageTag string

@description('Unique suffix for this Container Apps revision.')
param revisionSuffix string

@description('Container App name for the blue/green deployment slot.')
param applicationName string

@description('Connect this slot to Discord after search indexes are ready.')
param enableDiscord bool = false

@secure()
param discordToken string

@secure()
param githubToken string

@secure()
param discordAllowedUserIds string = ''

var baseName = 'aspire-discord-${environmentName}'
var compactName = 'aspirediscord${resourceSuffix}'
var foundryEndpoint = 'https://aspire-discord-ai-${resourceSuffix}.openai.azure.com'
var searchEndpoint = 'https://aspire-discord-search-${resourceSuffix}.search.windows.net'
var slotName = endsWith(applicationName, '-green') ? 'green' : 'blue'
var apiIndexName = 'aspire-api-${slotName}'
var docsIndexName = 'aspire-docs-${slotName}'
var tags = {
  application: 'aspire-discord'
  environment: environmentName
  managedBy: 'bicep'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${baseName}-id'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: compactName
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: '${baseName}-env'
}

resource application 'Microsoft.App/containerApps@2025-07-01' = {
  name: applicationName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 3000
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'auto'
      }
      registries: [
        {
          identity: identity.id
          server: registry.properties.loginServer
        }
      ]
      secrets: concat(
        [
          {
            name: 'discord-token'
            value: discordToken
          }
          {
            name: 'github-token'
            value: githubToken
          }
        ],
        empty(discordAllowedUserIds)
          ? []
          : [
              {
                name: 'discord-allowed-users'
                value: discordAllowedUserIds
              }
            ]
      )
    }
    template: {
      revisionSuffix: revisionSuffix
      containers: [
        {
          name: 'bot'
          image: '${registry.properties.loginServer}/aspire-discord-bot:${imageTag}'
          env: concat(
            [
              {
                name: 'NODE_ENV'
                value: 'production'
              }
              {
                name: 'HOST'
                value: '0.0.0.0'
              }
              {
                name: 'PORT'
                value: '3000'
              }
              {
                name: 'AI_PROVIDER'
                value: 'azureaifoundry'
              }
              {
                name: 'AI_ENDPOINT'
                value: foundryEndpoint
              }
              {
                name: 'AI_CHAT_MODEL'
                value: 'gpt-5.6-sol'
              }
              {
                name: 'AI_REASONING_EFFORT'
                value: 'low'
              }
              {
                name: 'AI_EMBEDDING_PROVIDER'
                value: 'azureaifoundry'
              }
              {
                name: 'AI_EMBEDDING_ENDPOINT'
                value: foundryEndpoint
              }
              {
                name: 'AI_EMBEDDING_MODEL'
                value: 'text-embedding-3-small'
              }
              {
                name: 'AI_EMBEDDING_DIMENSIONS'
                value: '1536'
              }
              {
                name: 'AZURE_CLIENT_ID'
                value: identity.properties.clientId
              }
              {
                name: 'AZURE_TOKEN_CREDENTIALS'
                value: 'ManagedIdentityCredential'
              }
              {
                name: 'COPILOT_RUNTIME_BASE_PATH'
                value: '/tmp/copilot-runtime'
              }
              {
                name: 'DISCORD_MENTION_ENABLED'
                value: 'true'
              }
              {
                name: 'GITHUB_MCP_TOKEN'
                secretRef: 'github-token'
              }
              {
                name: 'VECTOR_STORE_API_INDEX'
                value: apiIndexName
              }
              {
                name: 'VECTOR_STORE_DOCS_INDEX'
                value: docsIndexName
              }
              {
                name: 'VECTOR_STORE_ENDPOINT'
                value: searchEndpoint
              }
              {
                name: 'VECTOR_STORE_PROVIDER'
                value: 'azuresearch'
              }
            ],
            enableDiscord
              ? [
                  {
                    name: 'DISCORD_TOKEN'
                    secretRef: 'discord-token'
                  }
                ]
              : [],
            empty(discordAllowedUserIds)
              ? []
              : [
                  {
                    name: 'DISCORD_ALLOWED_USER_IDS'
                    secretRef: 'discord-allowed-users'
                  }
                ]
          )
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 15
              periodSeconds: 15
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
          resources: {
            cpu: json('0.75')
            memory: '1.5Gi'
          }
        }
        {
          name: 'ingestion'
          image: '${registry.properties.loginServer}/aspire-discord-ingestion:${imageTag}'
          env: [
            {
              name: 'DOTNET_ENVIRONMENT'
              value: 'Production'
            }
            {
              name: 'ASPNETCORE_URLS'
              value: 'http://+:8080'
            }
            {
              name: 'Ai__Provider'
              value: 'azureaifoundry'
            }
            {
              name: 'Ai__EmbeddingProvider'
              value: 'azureaifoundry'
            }
            {
              name: 'Ai__EmbeddingEndpoint'
              value: foundryEndpoint
            }
            {
              name: 'Ai__EmbeddingModel'
              value: 'text-embedding-3-small'
            }
            {
              name: 'Ai__EmbeddingDimensions'
              value: '1536'
            }
            {
              name: 'ApiSurface__CachePath'
              value: '/tmp/aspire-discord/git'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'AZURE_TOKEN_CREDENTIALS'
              value: 'ManagedIdentityCredential'
            }
            {
              name: 'Ingestion__GitHubToken'
              secretRef: 'github-token'
            }
            {
              name: 'Ingestion__SourceMode'
              value: 'github'
            }
            {
              name: 'ApiSurface__CollectionName'
              value: apiIndexName
            }
            {
              name: 'Ingestion__CollectionName'
              value: docsIndexName
            }
            {
              name: 'VectorStore__Endpoint'
              value: searchEndpoint
            }
            {
              name: 'VectorStore__GenerationRetention'
              value: '2'
            }
            {
              name: 'VectorStore__Provider'
              value: 'azuresearch'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              tcpSocket: {
                port: 8080
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 10
              failureThreshold: 3
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        maxReplicas: 1
        minReplicas: 1
      }
    }
  }
}

output applicationName string = application.name
output applicationUrl string = 'https://${application.properties.configuration.ingress.fqdn}'
output discordEnabled bool = enableDiscord
