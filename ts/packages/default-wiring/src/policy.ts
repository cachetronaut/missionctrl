import type { PolicyPort } from '@missionctrl/core';
import type { PolicyInput as CorePolicyInput } from '@verdik/core';
import { allowWithinTokenPolicy } from '@verdik/rules-local';

export function allowWithinToken(): PolicyPort {
  const engine = allowWithinTokenPolicy();
  return {
    async decide(input) {
      return engine.decide(input as unknown as CorePolicyInput);
    },
  };
}
