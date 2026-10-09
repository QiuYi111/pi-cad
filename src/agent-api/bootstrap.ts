import { pinMechanicalActionContracts } from "../domains/mechanical/register-action.ts";

let bootstrapped = false;

/** Pin the live Mechanical action schemas into the Action Registry, once per process. */
export function bootstrapAgentApiContracts(): void {
  if (bootstrapped) return;
  pinMechanicalActionContracts();
  bootstrapped = true;
}
