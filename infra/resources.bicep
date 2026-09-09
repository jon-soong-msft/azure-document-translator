@description('Primary location for all resources.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Unique token used to derive globally-unique resource names.')
param resourceToken string

@description('Principal id to grant local-dev data-plane access (optional).')
param principalId string = ''

@description('Type of the principal granted local-dev access.')
param principalType string = 'User'

@description('Username for the app sign-in gate.')
param appUsername string

@description('Password for the app sign-in gate (stored as a Container App secret).')
@secure()
param appPassword string

@description('Secret used to sign app session cookies (stored as a Container App secret).')
@secure()
param authSecret string

@description('Opt-in: tag the storage account SecurityControl=Ignore to exempt it from an org security-baseline policy that force-disables public network access. Leave false unless you know your tenant needs it — prefer private endpoints.')
param exemptStorageFromSecurityBaseline bool = false

// Resource name abbreviations (https://aka.ms/azure-resource-abbreviations).
var abbrs = {
  containerRegistry: 'cr'
  containerAppsEnv: 'cae'
  containerApp: 'ca'
  logAnalytics: 'log'
  applicationInsights: 'appi'
  managedIdentity: 'id'
  cognitiveServices: 'cog'
  storageAccount: 'st'
}

// Well-known Azure built-in role definition IDs.
var roles = {
  cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

var sourceContainerName = 'source'
var targetContainerName = 'target'

// ---------------------------------------------------------------------------
// User-assigned managed identity used by the Container App (keyless auth).
// ---------------------------------------------------------------------------
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${abbrs.managedIdentity}-${resourceToken}'
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Observability: Log Analytics workspace for the Container Apps environment.
// ---------------------------------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${abbrs.logAnalytics}-${resourceToken}'
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
  }
}

// Application Insights (workspace-based) receives the app's end-to-end
// distributed traces, dependencies, custom metrics and Live Metrics via the
// Azure Monitor OpenTelemetry Distro. It's backed by the same Log Analytics
// workspace as the Container Apps console logs, so everything is queryable in
// one place.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${abbrs.applicationInsights}-${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
  }
}

// ---------------------------------------------------------------------------
// Azure Container Registry for the app image.
// ---------------------------------------------------------------------------
resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: '${abbrs.containerRegistry}${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Azure AI multi-service account: OCR (Document Intelligence) + Translator.
// System-assigned identity lets the Translator read/write blobs for batch PDF.
// ---------------------------------------------------------------------------
resource ai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${abbrs.cognitiveServices}-${resourceToken}'
  location: location
  tags: tags
  kind: 'CognitiveServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    // Required for Entra ID (keyless) auth and the Document Translation custom domain.
    customSubDomainName: '${abbrs.cognitiveServices}-${resourceToken}'
    publicNetworkAccess: 'Enabled'
    // Enforce keyless (Microsoft Entra ID) authentication.
    disableLocalAuth: true
  }
}

// ---------------------------------------------------------------------------
// Storage account + containers used by batch (layout-preserving) PDF translation.
// ---------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${abbrs.storageAccount}${resourceToken}'
  location: location
  // Optional, opt-in policy exemption. Some organizations run an "Azure Security
  // Baseline" policy with a Modify effect that force-disables storage public
  // network access, which breaks the layout-preserving PDF (batch) path because
  // it must upload to Blob Storage. Where that policy honours a
  // `SecurityControl: Ignore` tag, setting exemptStorageFromSecurityBaseline
  // keeps the account exempt so `azd up` doesn't silently re-break translation.
  //
  // OFF BY DEFAULT: it weakens your security posture and only applies if your
  // tenant's policy actually recognises this tag. Prefer a private endpoint +
  // VNet integration for any non-demo deployment.
  tags: exemptStorageFromSecurityBaseline ? union(tags, { SecurityControl: 'Ignore' }) : tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    // Auto-clean translation working files so nothing lingers.
    deleteRetentionPolicy: { enabled: false }
  }

  resource sourceContainer 'containers' = {
    name: sourceContainerName
    properties: { publicAccess: 'None' }
  }
  resource targetContainer 'containers' = {
    name: targetContainerName
    properties: { publicAccess: 'None' }
  }
}

// Auto-delete translation working blobs after 1 day to avoid accumulation.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-translation-blobs'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ '${sourceContainerName}/', '${targetContainerName}/' ]
            }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 1 } }
            }
          }
        }
      ]
    }
  }
}

// App identity can read/write blobs (upload source, download translated output).
resource appStorageAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, appIdentity.id, roles.storageBlobDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// The Translator service identity reads source + writes target during batch jobs.
resource aiStorageAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, ai.id, roles.storageBlobDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: ai.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// App identity can call the AI services data plane (OCR + translation).
resource appCogAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(ai.id, appIdentity.id, roles.cognitiveServicesUser)
  scope: ai
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesUser)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Optional: grant the local developer (azd principal) the same data-plane roles
// so the app can run locally against these resources with `az login`.
// ---------------------------------------------------------------------------
resource devCogAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(ai.id, principalId, roles.cognitiveServicesUser)
  scope: ai
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesUser)
    principalId: principalId
    principalType: principalType
  }
}

resource devStorageAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(storage.id, principalId, roles.storageBlobDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: principalId
    principalType: principalType
  }
}

// ---------------------------------------------------------------------------
// Container Apps environment + the Next.js web app.
// ---------------------------------------------------------------------------
resource containerAppsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${abbrs.containerAppsEnv}-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// Placeholder image used on first provision; azd builds & swaps the real image.
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${abbrs.containerApp}-web-${resourceToken}'
  location: location
  // azd targets this container app by the azd-service-name tag.
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      // Sign-in credentials + cookie-signing secret, kept out of plain env vars.
      secrets: [
        { name: 'app-password', value: appPassword }
        { name: 'auth-secret', value: authSecret }
      ]
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: placeholderImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
            { name: 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', value: ai.properties.endpoint }
            { name: 'AZURE_DOCUMENT_TRANSLATION_ENDPOINT', value: ai.properties.endpoint }
            { name: 'AZURE_TRANSLATOR_REGION', value: location }
            { name: 'AZURE_TRANSLATOR_RESOURCE_ID', value: ai.id }
            { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
            { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.properties.primaryEndpoints.blob }
            { name: 'AZURE_STORAGE_SOURCE_CONTAINER', value: sourceContainerName }
            { name: 'AZURE_STORAGE_TARGET_CONTAINER', value: targetContainerName }
            // Optional per-translation evaluation report (characters/cost/time).
            // Set to 'false' to hide the feature entirely.
            { name: 'EVALUATION_ENABLED', value: 'true' }
            // App sign-in gate. Username is non-sensitive; password + secret are secretRefs.
            { name: 'APP_USERNAME', value: appUsername }
            { name: 'APP_PASSWORD', secretRef: 'app-password' }
            { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
            // Application Insights: turns on the Azure Monitor OpenTelemetry
            // Distro (end-to-end distributed tracing). OTEL_SERVICE_NAME is the
            // Cloud Role Name shown on the Application Map.
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            { name: 'OTEL_SERVICE_NAME', value: 'doc-translator' }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.properties.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = registry.name
output SERVICE_WEB_NAME string = web.name
output SERVICE_WEB_URI string = 'https://${web.properties.configuration.ingress.fqdn}'

output AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT string = ai.properties.endpoint
output AZURE_DOCUMENT_TRANSLATION_ENDPOINT string = ai.properties.endpoint
output AZURE_TRANSLATOR_REGION string = location
output AZURE_TRANSLATOR_RESOURCE_ID string = ai.id
output AZURE_STORAGE_ACCOUNT_NAME string = storage.name
output AZURE_STORAGE_BLOB_ENDPOINT string = storage.properties.primaryEndpoints.blob
output AZURE_STORAGE_SOURCE_CONTAINER string = sourceContainerName
output AZURE_STORAGE_TARGET_CONTAINER string = targetContainerName
output APPLICATIONINSIGHTS_CONNECTION_STRING string = appInsights.properties.ConnectionString
