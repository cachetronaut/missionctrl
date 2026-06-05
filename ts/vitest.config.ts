import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@missionctrl/core': fileURLToPath(new URL('packages/core/src/index.ts', import.meta.url)),
      '@missionctrl/default-wiring': fileURLToPath(
        new URL('packages/default-wiring/src/index.ts', import.meta.url),
      ),
      '@missionctrl/surface-http': fileURLToPath(
        new URL('packages/surface-http/src/index.ts', import.meta.url),
      ),
      '@approval-surface/core': fileURLToPath(
        new URL('../../approval-surface/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@approval-surface/local': fileURLToPath(
        new URL('../../approval-surface/ts/packages/local/src/index.ts', import.meta.url),
      ),
      '@nvoke/core': fileURLToPath(
        new URL('../../nvoke/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@nvoke/registry-local': fileURLToPath(
        new URL('../../nvoke/ts/packages/registry-local/src/index.ts', import.meta.url),
      ),
      '@verdik/core': fileURLToPath(
        new URL('../../verdik/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@verdik/rules-local': fileURLToPath(
        new URL('../../verdik/ts/packages/rules-local/src/index.ts', import.meta.url),
      ),
      '@plugg/core': fileURLToPath(
        new URL('../../plugg/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@grantz/core': fileURLToPath(
        new URL('../../grantz/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@grantz/signer-local': fileURLToPath(
        new URL('../../grantz/ts/packages/signer-local/src/index.ts', import.meta.url),
      ),
      '@grantz/revocation-local': fileURLToPath(
        new URL('../../grantz/ts/packages/revocation-local/src/index.ts', import.meta.url),
      ),
      '@delta-v/core': fileURLToPath(
        new URL('../../deltav/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@delta-v/store-local': fileURLToPath(
        new URL('../../deltav/ts/packages/store-local/src/index.ts', import.meta.url),
      ),
      '@axiongraph/core': fileURLToPath(
        new URL('../../axiongraph/ts/packages/core/src/index.ts', import.meta.url),
      ),
      '@axiongraph/store-local': fileURLToPath(
        new URL('../../axiongraph/ts/packages/store-local/src/index.ts', import.meta.url),
      ),
    },
  },
});
