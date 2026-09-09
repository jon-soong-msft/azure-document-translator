targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment; used to derive the resource group and resource names.')
param environmentName string

@minLength(1)
@description('Primary location for all resources.')
param location string

@description('Id of the user or service principal to grant data-plane access for local development. Defaults to the azd principal.')
param principalId string = ''

@description('Type of the principal: "User" for interactive azd, "ServicePrincipal" for CI.')
@allowed([ 'User', 'ServicePrincipal' ])
param principalType string = 'User'

@description('Username for the app sign-in gate. Required — set APP_USERNAME in the azd environment.')
@minLength(1)
param appUsername string

@description('Password for the app sign-in gate. Required — set APP_PASSWORD in the azd environment.')
@minLength(12)
@secure()
param appPassword string

@description('Secret used to sign session cookies. Required — set AUTH_SECRET to a high-entropy random string (e.g. `openssl rand -base64 48`). Never derive it from deployment metadata.')
@minLength(32)
@secure()
param authSecret string

@description('Opt-in: tag the storage account SecurityControl=Ignore to exempt it from an org security-baseline policy that force-disables public network access. Leave false unless you know your tenant needs it — prefer private endpoints.')
param exemptStorageFromSecurityBaseline bool = false

var tags = { 'azd-env-name': environmentName }
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  scope: rg
  name: 'resources'
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    principalId: principalId
    principalType: principalType
    appUsername: appUsername
    appPassword: appPassword
    authSecret: authSecret
    exemptStorageFromSecurityBaseline: exemptStorageFromSecurityBaseline
  }
}

// Outputs consumed by azd and the app.
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.AZURE_CONTAINER_REGISTRY_NAME
output SERVICE_WEB_NAME string = resources.outputs.SERVICE_WEB_NAME
output SERVICE_WEB_URI string = resources.outputs.SERVICE_WEB_URI

output AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT string = resources.outputs.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
output AZURE_DOCUMENT_TRANSLATION_ENDPOINT string = resources.outputs.AZURE_DOCUMENT_TRANSLATION_ENDPOINT
output AZURE_TRANSLATOR_REGION string = resources.outputs.AZURE_TRANSLATOR_REGION
output AZURE_TRANSLATOR_RESOURCE_ID string = resources.outputs.AZURE_TRANSLATOR_RESOURCE_ID
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.AZURE_STORAGE_ACCOUNT_NAME
output AZURE_STORAGE_BLOB_ENDPOINT string = resources.outputs.AZURE_STORAGE_BLOB_ENDPOINT
output AZURE_STORAGE_SOURCE_CONTAINER string = resources.outputs.AZURE_STORAGE_SOURCE_CONTAINER
output AZURE_STORAGE_TARGET_CONTAINER string = resources.outputs.AZURE_STORAGE_TARGET_CONTAINER
output APPLICATIONINSIGHTS_CONNECTION_STRING string = resources.outputs.APPLICATIONINSIGHTS_CONNECTION_STRING
