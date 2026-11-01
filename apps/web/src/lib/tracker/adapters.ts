/**
 * The registry of tracker web adapters, by provider: the one module outside
 * each provider's folder that knows them. Neutral code reaches a provider's
 * specifics only through `trackerAdapter` and `trackerExtras`.
 */
import "server-only";
import type { TrackerCapability, TrackerGateway, TrackerProvider } from "@omniralph/tracker";
import type { TrackerExtras, TrackerWebAdapter } from "./adapter";
import { linearWebAdapter } from "./linear/adapter";

const ADAPTERS: Record<TrackerProvider, TrackerWebAdapter> = {
  linear: linearWebAdapter,
};

/** The web adapter of a tracker provider. */
export function trackerAdapter(provider: TrackerProvider): TrackerWebAdapter {
  const adapter = Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : undefined;
  if (!adapter) throw new Error(`There is no web adapter for the ${provider} tracker`);
  return adapter;
}

const knownProvider = (provider: string): provider is TrackerProvider =>
  Object.hasOwn(ADAPTERS, provider);

/** The gateway's provider-only reads, or null when it has none (any tracker works without them). */
export function trackerExtras(gateway: TrackerGateway): TrackerExtras | null {
  return knownProvider(gateway.provider) ? ADAPTERS[gateway.provider].extras(gateway) : null;
}

/** The provider's name as people read it ("Linear"; "the tracker" for an unknown one). */
export function trackerName(provider: TrackerProvider): string {
  return knownProvider(provider) ? ADAPTERS[provider].name : "the tracker";
}

/** The provider's file of issue conventions in a repository (`TRACKER.md` for an unknown one). */
export function trackerConventionsFile(provider: TrackerProvider): string {
  return knownProvider(provider) ? ADAPTERS[provider].conventionsFile : "TRACKER.md";
}

/** The tracker as prompts name it (the `tracker.*` prompt variables). */
export function trackerPromptInfo(provider: TrackerProvider): {
  name: string;
  conventionsFile: string;
} {
  return { name: trackerName(provider), conventionsFile: trackerConventionsFile(provider) };
}

/** The optional capabilities the provider's gateways have (none for an unknown one). */
export function trackerProviderCapabilities(
  provider: TrackerProvider,
): readonly TrackerCapability[] {
  return knownProvider(provider) ? ADAPTERS[provider].capabilities : [];
}
