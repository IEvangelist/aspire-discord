@description('Azure region of the existing application VNet.')
param location string = resourceGroup().location

param virtualNetworkName string
param subnetName string
param subnetAddressPrefix string
param allowedSourceAddressPrefix string
param networkSecurityGroupName string

var tags = {
  application: 'aspire-discord'
  managedBy: 'aspire'
  purpose: 'private-endpoint-network'
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: virtualNetworkName
}

resource securityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: networkSecurityGroupName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowHttpsFromContainerApps'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: allowedSourceAddressPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: subnetAddressPrefix
          destinationPortRange: '443'
        }
      }
      {
        name: 'DenyOtherInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// A child-resource PUT leaves the existing Container Apps subnet and its managed NSG untouched.
resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: network
  name: subnetName
  properties: {
    addressPrefix: subnetAddressPrefix
    delegations: []
    networkSecurityGroup: {
      id: securityGroup.id
    }
    privateEndpointNetworkPolicies: 'Enabled'
    privateLinkServiceNetworkPolicies: 'Disabled'
    serviceEndpoints: []
  }
}

output subnetId string = subnet.id
output networkSecurityGroupId string = securityGroup.id
