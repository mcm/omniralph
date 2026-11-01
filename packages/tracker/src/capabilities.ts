import {
  TRACKER_CAPABILITIES,
  TrackerCapabilityError,
  type TrackerCapability,
  type TrackerCapabilityMap,
  type TrackerGateway,
} from "./types.js";

/** A gateway known to have the capability `C`. */
export type GatewayWith<C extends TrackerCapability> = TrackerGateway &
  Required<Pick<TrackerCapabilityMap, C>>;

/** Whether the gateway has the optional capability (narrowing it if so). */
export function hasCapability<C extends TrackerCapability>(
  gateway: TrackerGateway,
  capability: C,
): gateway is GatewayWith<C> {
  return gateway[capability] !== undefined;
}

/** The capability's operations; a {@link TrackerCapabilityError} if the gateway has none. */
export function requireCapability<C extends TrackerCapability>(
  gateway: TrackerGateway,
  capability: C,
): TrackerCapabilityMap[C] {
  const operations = gateway[capability];
  if (operations === undefined) throw new TrackerCapabilityError(gateway.provider, capability);
  return operations as TrackerCapabilityMap[C];
}

/** Which optional capabilities the gateway has, e.g. to show or hide features. */
export function trackerCapabilities(gateway: TrackerGateway): Record<TrackerCapability, boolean> {
  return Object.fromEntries(
    TRACKER_CAPABILITIES.map((capability) => [capability, hasCapability(gateway, capability)]),
  ) as Record<TrackerCapability, boolean>;
}
