import { type AuthAdapter, AuthError, type Principal } from '@plugg/core';

export function devAuth(principals: Readonly<Record<string, Principal>>): AuthAdapter {
  return {
    async resolve(credential: string): Promise<Principal> {
      const principal = principals[credential];
      if (principal === undefined) {
        throw new AuthError('invalid_credential', 'Unknown dev credential');
      }
      return principal;
    },
  };
}

export const defaultDevPrincipal: Principal = {
  id: 'principal_dev_agent',
  kind: 'agent',
  claims: {
    org: 'local-demo',
  },
};
