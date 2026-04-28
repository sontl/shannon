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
}

export type RetryPreset = 'default' | 'subscription';

export type PipelineTarget = 'web' | 'mobile' | 'api';

export interface PipelineConfig {
  retry_preset?: RetryPreset;
  max_concurrent_pipelines?: number;
  mode?: 'whitebox' | 'graybox';
  target?: PipelineTarget;
}

export interface DistributedConfig {
  avoid: Rule[];
  focus: Rule[];
  authentication: Authentication | null;
  schemas: SchemaHint[];
  mobile: MobileConfig | null;
}
