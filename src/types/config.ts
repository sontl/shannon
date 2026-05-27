// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Configuration type definitions
 */

export type RuleType =
  | 'path'
  | 'subdomain'
  | 'domain'
  | 'method'
  | 'header'
  | 'parameter';

export interface Rule {
  description: string;
  type: RuleType;
  url_path: string;
}

export interface Rules {
  avoid?: Rule[];
  focus?: Rule[];
}

export type LoginType = 'form' | 'sso' | 'api' | 'basic';

export interface SuccessCondition {
  type: 'url' | 'cookie' | 'element' | 'redirect';
  value: string;
}

export interface Credentials {
  username: string;
  password: string;
  totp_secret?: string;
}

export interface Persona {
  name: string;
  role?: string;
  credentials: Credentials;
  login_url?: string;
  login_flow?: string[];
}

// Raw shape accepted from YAML — exactly one of credentials/personas is set,
// enforced by JSON schema. The parser auto-migrates credentials → personas.
export interface RawAuthentication {
  login_type: LoginType;
  login_url?: string;
  credentials?: Credentials;
  personas?: Persona[];
  login_flow?: string[];
  success_condition: SuccessCondition;
}

// Internal post-migrate shape — personas[] is always set.
export interface Authentication {
  login_type: LoginType;
  login_url?: string;
  personas: Persona[];
  login_flow?: string[];
  success_condition: SuccessCondition;
}

export type SchemaType = 'openapi' | 'swagger' | 'graphql';

export interface SchemaHint {
  url: string;
  type: SchemaType;
}

export interface ContextConfig {
  schemas?: SchemaHint[];
}

export type MobilePlatform = 'android' | 'ios';

export interface MobileConfig {
  platform: MobilePlatform;
  app_path?: string;
  device_id?: string;
  appium_url?: string;
  backend_api_url?: string;
  bundle_id?: string;
}

export interface Config {
  rules?: Rules;
  authentication?: RawAuthentication;
  pipeline?: PipelineConfig;
  context?: ContextConfig;
  mobile?: MobileConfig;
  network?: NetworkConfig;
}

export type RetryPreset = 'default' | 'subscription';

export type PipelineTarget = 'web' | 'mobile' | 'api' | 'network';

export interface PipelineConfig {
  retry_preset?: RetryPreset;
  max_concurrent_pipelines?: number;
  mode?: 'whitebox' | 'graybox';
  target?: PipelineTarget;
  network?: NetworkPipelineConfig;
}

export type EngagementMode = 'external' | 'internal' | 'hybrid';
export type VulnScanner = 'nuclei' | 'openvas' | 'nessus' | 'none';
export type CrackingCompute = 'cpu' | 'gpu' | 'cloud';

export interface NetworkScope {
  targets: string[];
  excludes?: string[];
}

export interface NetworkAdConfig {
  enabled: boolean;
  domain?: string;
  dc_ip?: string;
}

export interface NetworkScannersConfig {
  vuln_scanner: VulnScanner;
  nessus_license_env?: string;
}

export interface NetworkRelayConfig {
  enabled: boolean;
  duration_minutes: number;
  network_mode?: 'host' | 'bridge';
}

export interface NetworkCrackingConfig {
  enabled: boolean;
  budget_minutes: number;
  compute: CrackingCompute;
  wordlist?: string;
}

export interface NetworkSafetyConfig {
  lockout_threshold: number;
  coercion_authorized: boolean;
  avoid_production_dcs: boolean;
}

export interface NetworkAttackFrameworkConfig {
  attack_version: number;
}

// Inline pipeline-level network settings (under pipeline.network.*).
// Required when pipeline.target === 'network'.
export interface NetworkPipelineConfig {
  engagement_mode: EngagementMode;
  scope: NetworkScope;
  ad: NetworkAdConfig;
  scanners: NetworkScannersConfig;
  relay: NetworkRelayConfig;
  cracking: NetworkCrackingConfig;
  safety: NetworkSafetyConfig;
  attack_framework: NetworkAttackFrameworkConfig;
}

// Top-level network config — for any settings that don't fit cleanly under
// pipeline.network.* (e.g. shared infra references). Reserved for future use;
// currently empty so YAML config files can declare a `network:` key alongside
// `mobile:` for symmetry without being rejected by the schema.
export interface NetworkConfig {
  // intentionally empty for now; extend as needed.
}

export interface DistributedConfig {
  avoid: Rule[];
  focus: Rule[];
  authentication: Authentication | null;
  schemas: SchemaHint[];
  mobile: MobileConfig | null;
  network: NetworkPipelineConfig | null;
}
