import noThresholdLiterals from './rules/no-threshold-literals.js'
import noDirectProviderSdk from './rules/no-direct-provider-sdk.js'
import noDirectVendorHttp from './rules/no-direct-vendor-http.js'
import routeHandlerImports from './rules/route-handler-imports.js'

const plugin = {
  meta: { name: 'eslint-plugin-sortiva', version: '0.0.0' },
  rules: {
    'no-threshold-literals': noThresholdLiterals,
    'no-direct-provider-sdk': noDirectProviderSdk,
    'no-direct-vendor-http': noDirectVendorHttp,
    'route-handler-imports': routeHandlerImports,
  },
}

export default plugin
