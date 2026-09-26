export { appRouter, type AppRouter } from './routers/index.js';
export { buildControlApp, PRINCIPAL_HEADER, type ControlAppOptions } from './app.js';
export type { ControlDeps, Context } from './trpc.js';
export {
  provisionTenant,
  activateOnFirstSignIn,
  type ProvisionTenantInput,
  type ProvisionedTenant,
  type ProvisioningDeps,
} from './provisioning.js';
export { injectFetch } from './inject-fetch.js';
