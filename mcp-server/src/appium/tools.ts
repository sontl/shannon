// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Appium MCP Tools
 *
 * Exposes mobile device interaction tools via the Appium REST API.
 * Each tool sends HTTP requests to the Appium server (WebDriver W3C protocol).
 *
 * NOTE: This is a minimal implementation using the raw Appium HTTP API
 * for simplicity and zero additional dependencies. A production version
 * could use a proper WebDriverIO client.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

interface AppiumSession {
  sessionId: string | null;
}

const session: AppiumSession = { sessionId: null };

async function appiumRequest(
  appiumUrl: string,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `${appiumUrl}${urlPath}`;
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Appium request failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function ensureSession(appiumUrl: string): Promise<string> {
  if (session.sessionId) return session.sessionId;

  const result = await appiumRequest(appiumUrl, 'GET', '/sessions') as { value: Array<{ id: string }> };
  if (result.value.length > 0) {
    session.sessionId = result.value[0]!.id;
    return session.sessionId;
  }

  throw new Error(
    'No active Appium session. Start one first with appium_launch_app.'
  );
}

type ElementResult = { value: { ELEMENT?: string; 'element-6066-11e4-a52e-4f735466cecf'?: string } };

function extractElementId(result: ElementResult): string {
  const id = result.value.ELEMENT || result.value['element-6066-11e4-a52e-4f735466cecf'];
  if (!id) throw new Error('Element not found');
  return id;
}

// === Schema shapes ===

const tapSchema = {
  strategy: z.enum(['accessibility id', 'xpath', 'id', 'class name']).describe('Element locator strategy'),
  selector: z.string().describe('Element selector value'),
};

const typeSchema = {
  strategy: z.enum(['accessibility id', 'xpath', 'id', 'class name']).describe('Element locator strategy'),
  selector: z.string().describe('Element selector value'),
  text: z.string().describe('Text to type'),
};

const swipeSchema = {
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
};

const launchSchema = {
  app_path: z.string().optional().describe('Path to APK/IPA file'),
  platform: z.enum(['android', 'ios']).optional().describe('Platform (default: android)'),
  bundle_id: z.string().optional().describe('App bundle ID / package name'),
  app_activity: z.string().optional().describe('Android main activity (e.g. .MainActivity). Required on Android if app is pre-installed and appActivity cannot be auto-detected.'),
  no_reset: z.boolean().optional().describe('If true, do not reset app state before launch. Default: true for pre-installed apps.'),
};

const emptySchema = {};

// === Tool handlers ===

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Create Appium tool definitions bound to an Appium server URL.
 */
export function createAppiumTools(appiumUrl: string) {
  return [
    tool(
      'appium_tap',
      'Tap an element on the mobile screen by accessibility ID, XPath, or resource ID.',
      tapSchema,
      async (args: { strategy: string; selector: string }): Promise<ToolResult> => {
        const sid = await ensureSession(appiumUrl);
        const findResult = await appiumRequest(appiumUrl, 'POST', `/session/${sid}/element`, {
          using: args.strategy, value: args.selector,
        }) as ElementResult;
        const elementId = extractElementId(findResult);
        await appiumRequest(appiumUrl, 'POST', `/session/${sid}/element/${elementId}/click`, {});
        return textResult(`Tapped element: ${args.strategy}="${args.selector}"`);
      }
    ),

    tool(
      'appium_type',
      'Type text into an element on the mobile screen.',
      typeSchema,
      async (args: { strategy: string; selector: string; text: string }): Promise<ToolResult> => {
        const sid = await ensureSession(appiumUrl);
        const findResult = await appiumRequest(appiumUrl, 'POST', `/session/${sid}/element`, {
          using: args.strategy, value: args.selector,
        }) as ElementResult;
        const elementId = extractElementId(findResult);
        await appiumRequest(appiumUrl, 'POST', `/session/${sid}/element/${elementId}/value`, {
          text: args.text,
        });
        return textResult(`Typed "${args.text}" into: ${args.strategy}="${args.selector}"`);
      }
    ),

    tool(
      'appium_swipe',
      'Swipe on the mobile screen in a given direction.',
      swipeSchema,
      async (args: { direction: string }): Promise<ToolResult> => {
        const sid = await ensureSession(appiumUrl);
        const sizeResult = await appiumRequest(appiumUrl, 'GET', `/session/${sid}/window/rect`) as {
          value: { width: number; height: number };
        };
        const { width, height } = sizeResult.value;
        const cx = Math.round(width / 2);
        const cy = Math.round(height / 2);
        const offsets: Record<string, { sx: number; sy: number; ex: number; ey: number }> = {
          up:    { sx: cx, sy: Math.round(height * 0.7), ex: cx, ey: Math.round(height * 0.3) },
          down:  { sx: cx, sy: Math.round(height * 0.3), ex: cx, ey: Math.round(height * 0.7) },
          left:  { sx: Math.round(width * 0.8), sy: cy, ex: Math.round(width * 0.2), ey: cy },
          right: { sx: Math.round(width * 0.2), sy: cy, ex: Math.round(width * 0.8), ey: cy },
        };
        const o = offsets[args.direction]!;
        await appiumRequest(appiumUrl, 'POST', `/session/${sid}/actions`, {
          actions: [{
            type: 'pointer', id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: o.sx, y: o.sy },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerMove', duration: 800, x: o.ex, y: o.ey },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
        return textResult(`Swiped ${args.direction}`);
      }
    ),

    tool(
      'appium_screenshot',
      'Capture a screenshot of the current mobile screen. Returns base64-encoded PNG.',
      emptySchema,
      async (): Promise<ToolResult> => {
        const sid = await ensureSession(appiumUrl);
        const result = await appiumRequest(appiumUrl, 'GET', `/session/${sid}/screenshot`) as { value: string };
        return textResult(`Screenshot captured (${result.value.length} chars base64).`);
      }
    ),

    tool(
      'appium_hierarchy',
      'Get the UI element hierarchy (accessibility tree) of the current screen.',
      emptySchema,
      async (): Promise<ToolResult> => {
        const sid = await ensureSession(appiumUrl);
        const result = await appiumRequest(appiumUrl, 'GET', `/session/${sid}/source`) as { value: string };
        return textResult(result.value);
      }
    ),

    tool(
      'appium_back',
      'Press the device back button.',
      emptySchema,
      async (): Promise<ToolResult> => {
        const sid = await ensureSession(appiumUrl);
        await appiumRequest(appiumUrl, 'POST', `/session/${sid}/back`, {});
        return textResult('Pressed back button');
      }
    ),

    tool(
      'appium_launch_app',
      'Launch or restart the mobile app. Creates a new Appium session.',
      launchSchema,
      async (args: {
        app_path: string | undefined;
        platform: 'android' | 'ios' | undefined;
        bundle_id: string | undefined;
        app_activity: string | undefined;
        no_reset: boolean | undefined;
      }): Promise<ToolResult> => {
        const platform = args.platform || 'android';
        const capabilities: Record<string, unknown> = {
          platformName: platform === 'ios' ? 'iOS' : 'Android',
          'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
        };
        if (args.app_path || process.env.APPIUM_APP_PATH) {
          capabilities['appium:app'] = args.app_path || process.env.APPIUM_APP_PATH;
        }
        if (args.bundle_id) {
          if (platform === 'ios') {
            capabilities['appium:bundleId'] = args.bundle_id;
          } else {
            capabilities['appium:appPackage'] = args.bundle_id;
            // Android requires appActivity when app is pre-installed and appPath isn't provided.
            // Default to .MainActivity — works for most apps; caller can override via app_activity.
            const activity = args.app_activity || process.env.APPIUM_APP_ACTIVITY || '.MainActivity';
            capabilities['appium:appActivity'] = activity;
          }
        }
        // Default noReset=true so pre-installed app state is preserved
        capabilities['appium:noReset'] = args.no_reset !== false;
        if (process.env.APPIUM_DEVICE_ID) {
          capabilities['appium:udid'] = process.env.APPIUM_DEVICE_ID;
        }
        const result = await appiumRequest(appiumUrl, 'POST', '/session', {
          capabilities: { alwaysMatch: capabilities },
        }) as { value: { sessionId: string } };
        session.sessionId = result.value.sessionId;
        return textResult(`App launched. Session: ${session.sessionId}`);
      }
    ),
  ];
}
